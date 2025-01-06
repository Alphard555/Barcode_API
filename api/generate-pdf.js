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

const s3 = new AWS.S3();
const BUCKET_NAME = process.env.AWS_BUCKET_NAME || "packagebc";
const TEMP_DIR = "/tmp";

// Генерация PDF с одним штрихкодом
const generateBarcodePDF = async (code) => {
  try {
    const widthMm = 56;
    const heightMm = 40;
    const margin = 3;
    const spaceBetween = 2;

    const pageWidth = widthMm * 2.83465;
    const pageHeight = heightMm * 2.83465;
    const barcodeMargin = margin * 2.83465;
    const textMargin = spaceBetween * 2.83465;

    const barcodeBuffer = await bwipjs.toBuffer({
      bcid: "code128",
      text: code,
      scale: 3,
      height: 10,
      includetext: true,
      textxalign: "center",
    });

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    const barcodeImage = await pdfDoc.embedPng(barcodeBuffer);
    const { height } = barcodeImage.scale(0.5);

    page.drawImage(barcodeImage, {
      x: barcodeMargin,
      y: page.getHeight() - height - barcodeMargin - textMargin,
      width: pageWidth - 2 * barcodeMargin,
      height,
    });

    page.drawText(code, {
      x: barcodeMargin,
      y: page.getHeight() - height - barcodeMargin - 10,
      size: 6,
      color: rgb(0, 0, 0),
    });

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
