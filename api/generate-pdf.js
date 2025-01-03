const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");
const bwipjs = require("bwip-js");

// Временная директория для хранения PDF
const TEMP_DIR = "/tmp"; // Vercel поддерживает временные файлы в папке /tmp

// Генерация PDF с одним штрихкодом
const generateBarcodePDF = async (code) => {
  try {
    const barcodeBuffer = await bwipjs.toBuffer({
      bcid: "code128",
      text: code,
      scale: 3,
      height: 10,
      includetext: true,
      textxalign: "center",
    });

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([200, 100]);

    const barcodeImage = await pdfDoc.embedPng(barcodeBuffer);
    const { width, height } = barcodeImage.scale(0.5);
    page.drawImage(barcodeImage, {
      x: page.getWidth() / 2 - width / 2,
      y: page.getHeight() / 2 - height / 2,
      width,
      height,
    });

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

  const { codes } = req.body;

  if (!codes || !Array.isArray(codes) || codes.length === 0) {
    return res.status(400).json({ error: "Invalid input. Provide an array of codes." });
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
    const filePath = path.join(TEMP_DIR, fileName);

    fs.writeFileSync(filePath, mergedPdfBytes);

    res.setHeader("Content-Type", "application/json");
    res.json({ url: `/api/files/${fileName}` });
  } catch (err) {
    console.error("Error generating merged PDF:", err);
    res.status(500).json({ error: "Failed to generate PDF" });
  }
};
