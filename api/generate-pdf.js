const fs = require("fs");
const path = require("path");
const { PDFDocument, rgb } = require("pdf-lib");
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
    const barcodeMargin = margin * 2.83465;

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
    const barcodeScale = 0.6; // Масштаб штрихкода
    const { width, height } = barcodeImage.scale(barcodeScale);

    // Отрисовка штрихкода
    page.drawImage(barcodeImage, {
      x: (pageWidth - width) / 2, // Центровка по горизонтали
      y: pageHeight - height - barcodeMargin, // Расположение сверху
      width,
      height,
    });

    // Отрисовка текста под штрихкодом
    page.drawText(code, {
      x: (pageWidth - code.length * 5) / 2, // Центровка текста
      y: pageHeight - height - barcodeMargin - 15, // Под штрихкодом
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


// Основной обработчик
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  let { codes } = req.body;

  if (!Array.isArray(codes)) {
    codes = [codes];
  }

  if (!codes || codes.length === 0) {
    return res.status(400).json({ error: "Provide an array of codes" });
  }

  try {
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
  } catch (err) {
    console.error("Error processing request:", err);
    res.status(500).json({ error: "Failed to process request" });
  }
};
