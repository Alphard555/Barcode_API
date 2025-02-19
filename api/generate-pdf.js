// Импорты для генерации PDF (CommonJS)
const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");
const bwipjs = require("bwip-js");
const AWS = require("aws-sdk");
require("dotenv").config();

// Полифиллы для работы с pdfjs-dist в Node.js
const { createCanvas, ImageData, Path2D } = require("canvas");
global.ImageData = ImageData;
global.Path2D = Path2D;

// Конфигурация Yandex Object Storage
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || "ru-central1",
  endpoint: process.env.AWS_ENDPOINT || "https://storage.yandexcloud.net",
});
console.log("AWS Configured");
const s3 = new AWS.S3();
const BUCKET_NAME = process.env.AWS_BUCKET_NAME || "packagebc";

// Генерация PDF с одним штрихкодом (НЕ ТРОГАЕМ)
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
      color: { r: 0, g: 0, b: 0 }, // Черный цвет
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
  try {
    // Динамический импорт pdfjs-dist
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

    // Настройка worker и шрифтов
    pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
    pdfjsLib.setStandardFontDataUrl(require.resolve("pdfjs-dist/standard_fonts"));

    // Загрузка PDF
    const pdfData = new Uint8Array(pdfBuffer);
    const pdf = await pdfjsLib.getDocument(pdfData).promise;
    const decodedCodes = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);

      // Получаем размеры страницы
      const viewport = page.getViewport({ scale: 2.0 }); // Увеличиваем масштаб для лучшего качества
      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext("2d");

      // Рендерим страницу PDF на Canvas
      const renderContext = {
        canvasContext: ctx,
        viewport: viewport,
      };
      await page.render(renderContext).promise;

      // Преобразуем Canvas в Base64
      const imageBase64 = canvas.toDataURL("image/png").split(",")[1];

      // Динамический импорт @zxing/library
      const { BrowserMultiFormatReader, BarcodeFormat } = await import("@zxing/library");

      // Распознаем штрихкоды
      const codeReader = new BrowserMultiFormatReader();
      const hints = new Map();
      hints.set(
        codeReader.Hints.POSSIBLE_FORMATS,
        [BarcodeFormat.DATA_MATRIX, BarcodeFormat.EAN_13, BarcodeFormat.CODE_128]
      );

      try {
        const result = await codeReader.decodeFromImage(undefined, imageBase64, hints);
        if (result) {
          decodedCodes.push(result.text);
        }
      } catch (err) {
        console.warn("Не удалось распознать штрихкод:", err);
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