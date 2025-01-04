const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");
const bwipjs = require("bwip-js");

// Временная директория для хранения PDF
const TEMP_DIR = "/tmp"; 

// Генерация PDF с одним штрихкодом
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
    const barcodeBuffer = await bwipjs.toBuffer({
      bcid: "code128",      // Тип штрихкода
      text: code,           // Текст штрихкода
      scale: 3,             // Масштаб
      height: 10,           // Высота штрихкода
      includetext: true,    // Включить текст под штрихкодом
      textxalign: "center", // Выравнивание текста
    });

    // Создание PDF-документа
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([pageWidth, pageHeight]);

    // Встраиваем PNG штрихкода в PDF
    const barcodeImage = await pdfDoc.embedPng(barcodeBuffer);
    const { width, height } = barcodeImage.scale(0.5);

    // Располагаем штрихкод на странице
    page.drawImage(barcodeImage, {
      x: barcodeMargin,
      y: page.getHeight() - height - barcodeMargin - textMargin, // Отступ сверху
      width: pageWidth - 2 * barcodeMargin, // Ширина штрихкода с отступами
      height, // Высота штрихкода
    });

    // Добавляем текст под штрихкодом
    const fontSize = 6; // Размер шрифта для текста
    page.drawText(code, {
      x: barcodeMargin,
      y: page.getHeight() - height - barcodeMargin - fontSize, 
      font: await pdfDoc.embedFont(PDFDocument.Font.Helvetica),
      size: fontSize,
      color: rgb(0, 0, 0), 
    });

    // Сохраняем PDF
    return await pdfDoc.save();
  } catch (err) {
    console.error("Error generating barcode PDF:", err);
    throw new Error("Failed to generate barcode PDF");
  }
};

// Генерация объединенного PDF
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  let { codes } = req.body;

  // Принудительно преобразуем код в массив, если он не является массивом
  if (!Array.isArray(codes)) {
    console.log("Converting codes to array...");
    codes = [codes]; // Преобразуем в массив
  }

  if (!codes || codes.length === 0) {
    return res.status(400).json({ error: "Invalid input. Provide an array of codes." });
  }

  // Логирование входных данных для отладки
  console.log("Received codes:", codes);

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
    const filePath = path.join(TEMP_DIR, fileName);

    fs.writeFileSync(filePath, mergedPdfBytes);

    // Формируем полный URL для скачивания
    const fileUrl = `${req.protocol}://${req.get("host")}/api/files/${fileName}`;

    res.setHeader("Content-Type", "application/json");
    res.json({ url: fileUrl });
  } catch (err) {
    console.error("Error generating merged PDF:", err);
    res.status(500).json({ error: "Failed to generate PDF" });
  }
};
