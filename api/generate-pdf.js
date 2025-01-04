const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");
const bwipjs = require("bwip-js");

// Временная директория для хранения PDF
const TEMP_DIR = "/tmp"; 

// Генерация PDF с одним штрихкодом
const { rgb } = require("pdf-lib");

const generateBarcodePDF = async (code) => {
  try {
    const widthMm = 56;
    const heightMm = 40;
    const margin = 3; // 3 мм
    const spaceBetween = 2; // 2 мм

    const pageWidth = widthMm * 2.83465; 
    const pageHeight = heightMm * 2.83465; 
    const barcodeMargin = margin * 2.83465; 
    const textMargin = spaceBetween * 2.83465; 

    // Генерация штрихкода
    console.log("Generating barcode for code:", code);
    const barcodeBuffer = await bwipjs.toBuffer({
      bcid: "code128",      // Тип штрихкода
      text: code,           // Текст штрихкода
      scale: 3,             // Масштаб
      height: 10,           // Высота штрихкода
      includetext: true,    // Включить текст под штрихкодом
      textxalign: "center", // Выравнивание текста
    });
    console.log("Barcode generated successfully.");

    // Создание PDF-документа
    console.log("Creating PDF document...");
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([pageWidth, pageHeight]);

    // Встраиваем PNG штрихкода в PDF
    const barcodeImage = await pdfDoc.embedPng(barcodeBuffer);
    const { width, height } = barcodeImage.scale(0.5);

    // Располагаем штрихкод на странице
    console.log("Placing barcode on PDF page...");
    page.drawImage(barcodeImage, {
      x: barcodeMargin,
      y: page.getHeight() - height - barcodeMargin - textMargin, // Отступ сверху
      width: pageWidth - 2 * barcodeMargin, // Ширина штрихкода с отступами
      height, // Высота штрихкода
    });

    // Используем дефолтный шрифт Times-Roman (по умолчанию)
    console.log("Using default font (Times-Roman)...");
    const fontSize = 6; // Размер шрифта для текста

    // Добавляем текст под штрихкодом
    console.log("Adding text to PDF...");
    page.drawText(code, {
      x: barcodeMargin,
      y: page.getHeight() - height - barcodeMargin - fontSize, 
      size: fontSize,
      color: rgb(0, 0, 0), 
    });

    // Сохраняем PDF
    console.log("Saving PDF...");
    return await pdfDoc.save();
  } catch (err) {
    console.error("Error generating barcode PDF:", err);
    throw new Error("Failed to generate barcode PDF");
  }
};

// Генерация объединенного PDF
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    console.log("Received non-POST request method.");
    return res.status(405).send("Method Not Allowed");
  }

  let { codes } = req.body;

  // Принудительно преобразуем код в массив, если он не является массивом
  if (!Array.isArray(codes)) {
    console.log("Converting codes to array...");
    codes = [codes]; // Преобразуем в массив
  }

  if (!codes || codes.length === 0) {
    console.log("No codes provided.");
    return res.status(400).json({ error: "Invalid input. Provide an array of codes." });
  }

  // Логирование входных данных для отладки
  console.log("Received codes:", codes);

  try {
    const pdfBuffers = [];
    for (const code of codes) {
      console.log("Processing code:", code);
      const pdfBuffer = await generateBarcodePDF(code);
      pdfBuffers.push(pdfBuffer);
    }

    console.log("Merging PDF documents...");
    const mergedPdf = await PDFDocument.create();
    for (const pdfBuffer of pdfBuffers) {
      const pdfToMerge = await PDFDocument.load(pdfBuffer);
      const [page] = await mergedPdf.copyPages(pdfToMerge, [0]);
      mergedPdf.addPage(page);
    }

    const mergedPdfBytes = await mergedPdf.save();
    const fileName = `barcodes_${Date.now()}.pdf`;
    const filePath = path.join(TEMP_DIR, fileName);

    fs.writeFileSync(filePath, mergedPdfBytes);
    console.log(`PDF saved to: ${filePath}`);

    // Формируем полный URL для скачивания
    const fileUrl = `${req.protocol}://${req.get("host")}/api/files/${fileName}`;
    console.log("Generated file URL:", fileUrl);

    res.setHeader("Content-Type", "application/json");
    res.json({ url: fileUrl });
  } catch (err) {
    console.error("Error generating merged PDF:", err);
    res.status(500).json({ error: "Failed to generate PDF" });
  }
};


