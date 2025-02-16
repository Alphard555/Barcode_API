const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");
const bwipjs = require("bwip-js");
const AWS = require("aws-sdk");
require("dotenv").config(); // Подключение dotenv для работы с .env

// Конфигурация Yandex Object Storage из переменных окружения
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || "ru-central1",
  endpoint: process.env.AWS_ENDPOINT || "https://storage.yandexcloud.net",
});
console.log("AWS Configured");
const s3 = new AWS.S3();
const BUCKET_NAME = process.env.AWS_BUCKET_NAME || "packagebc";
const TEMP_DIR = "/tmp";

// Генерация PDF с одним штрихкодом
const generateBarcodePDF = async (code) => {
  try {
    console.log(`Generating barcode PDF for code: ${code}`);
    const widthMm = 56; // Ширина страницы в мм
    const heightMm = 40; // Высота страницы в мм
    const margin = 3; // Отступы в мм
    const pageWidth = widthMm * 2.83465; // Конвертация мм в точки
    const pageHeight = heightMm * 2.83465;
    const marginPts = margin * 2.83465; // Конвертация отступа в точки
    // Генерация изображения штрихкода
    const barcodeBuffer = await bwipjs.toBuffer({
      bcid: "code128", // Тип штрихкода
      text: code, // Код для генерации
      scale: 3, // Масштаб
      height: 10, // Высота штрихкода
      includetext: false, // Не включать текст внутри изображения
    });
    // Создание PDF-документа
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    const barcodeImage = await pdfDoc.embedPng(barcodeBuffer);
    // Рассчитываем максимальные размеры для штрихкода с учетом отступов
    const maxWidth = pageWidth - 2 * marginPts;
    const maxHeight = pageHeight - 2 * marginPts - 15; // Учитываем место для текста
    // Масштабируем изображение штрихкода, чтобы оно вписалось в доступное пространство
    const scale = Math.min(maxWidth / barcodeImage.width, maxHeight / barcodeImage.height);
    const scaledWidth = barcodeImage.width * scale;
    const scaledHeight = barcodeImage.height * scale;
    // Отрисовка штрихкода
    page.drawImage(barcodeImage, {
      x: (pageWidth - scaledWidth) / 2, // Центровка по горизонтали
      y: pageHeight - scaledHeight - marginPts - 15, // Центровка по вертикали с учетом текста
      width: scaledWidth,
      height: scaledHeight,
    });
    // Отрисовка текста под штрихкодом
    page.drawText(code, {
      x: (pageWidth - code.length * 6) / 2, // Центровка текста
      y: marginPts, // Расположение текста снизу страницы
      size: 10, // Размер текста
      color: rgb(0, 0, 0), // Черный цвет
    });
    console.log(`PDF generated for code: ${code}`);
    return await pdfDoc.save();
  } catch (err) {
    console.error("Error generating barcode PDF:", err);
    throw new Error("Failed to generate barcode PDF");
  }
};

// Функция для распознавания DataMatrix-кодов
async function decodeDataMatrixFromPDF(pdfBuffer) {
  const { PDFDocument } = require("pdf-lib");
  const { BrowserQRCodeReader } = require("@zxing/library");

  try {
    // Загрузка PDF
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const decodedCodes = [];

    for (let i = 0; i < pdfDoc.getPageCount(); i++) {
      const page = pdfDoc.getPages()[i];
      const embeddedImages = await page.getEmbeddedImages();

      for (const image of embeddedImages) {
        const imageBuffer = image.image.data;

        // Преобразуем изображение в формат, поддерживаемый zxing
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        const img = new Image();
        img.src = `data:image/png;base64,${imageBuffer.toString("base64")}`;
        await new Promise((resolve) => (img.onload = resolve));
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);

        // Распознаем DataMatrix-коды
        const codeReader = new BrowserQRCodeReader();
        const result = await codeReader.decodeFromCanvas(canvas, "data_matrix");
        if (result) {
          decodedCodes.push(result.text);
        }
      }
    }

    return decodedCodes;
  } catch (err) {
    console.error("Ошибка при распознавании DataMatrix:", err);
    return [];
  }
}

// Основной обработчик
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const { codes, file } = req.body;

  try {
    // Если переданы коды для генерации PDF
    if (codes) {
      if (!Array.isArray(codes)) {
        codes = [codes];
      }
      if (!codes || codes.length === 0) {
        return res.status(400).json({ error: "Provide an array of codes" });
      }

      const pdfBuffers = [];
      for (const code of codes) {
        const pdfBuffer = await generateBarcodePDF(code);
        pdfBuffers.push(pdfBuffer);
      }

      const mergedPdf = await PDFDocument.create();
      for (const pdfBuffer of pdfBuffers) {
        const pdfToMerge = await PDFDocument.load(pdfBuffer);
        const [page] = await mergedPdf.copyPages(pdfToMerge, [0]);
        mergedPdf.addPage(page);
      }

      const mergedPdfBytes = await mergedPdf.save();
      const fileName = `barcodes_${Date.now()}.pdf`;

      // Загрузка файла в Yandex Object Storage
      const uploadParams = {
        Bucket: BUCKET_NAME,
        Key: fileName,
        Body: Buffer.from(mergedPdfBytes),
        ContentType: "application/pdf",
      };
      console.log("File name:", fileName);
      console.log("Upload parameters:", uploadParams);
      const uploadResult = await s3.upload(uploadParams).promise();
      console.log("File uploaded to Yandex Object Storage:", uploadResult.Location);

      // Генерация временной ссылки
      const signedUrl = s3.getSignedUrl("getObject", {
        Bucket: BUCKET_NAME,
        Key: fileName,
        Expires: 3 * 24 * 60 * 60, // 3 дня
      });
      res.status(200).json({ url: signedUrl });
    }

    // Если передан файл для распознавания DataMatrix
    else if (file) {
      const pdfBuffer = Buffer.from(file, "base64");
      const decodedCodes = await decodeDataMatrixFromPDF(pdfBuffer);
      res.status(200).json({ codes: decodedCodes });
    } else {
      res.status(400).json({ error: "No codes or file provided" });
    }
  } catch (err) {
    console.error("Error processing request:", err);
    res.status(500).json({ error: "Failed to process request" });
  }
};