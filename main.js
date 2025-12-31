const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { PythonShell } = require('python-shell');
const piexif = require('piexifjs');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: {
      nodeIntegration: true,    
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

// Handler für den Ordner-Auswahl-Dialog
ipcMain.handle('open-folder-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
    if (result.canceled) {
        return null;
    } else {
        return result.filePaths[0];
    }
});

// Hilfsfunktion für saubere Dateinamen
function sanitize(str) {
    if (!str) return "";
    return str.toString().toLowerCase()
              .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
              .replace(/ß/g, 'ss')
              .replace(/[^a-z0-9]/g, '_');
}

ipcMain.on('analysiere-bild', async (event, inputPath) => {
    console.log("Input:", inputPath);
    let filesToProcess = [];

    try {
        const stats = fs.statSync(inputPath);
        if (stats.isDirectory()) {
            // Batch Modus: Alle Bilder im Ordner sammeln
            const allFiles = fs.readdirSync(inputPath);
            filesToProcess = allFiles
                .filter(f => f.match(/\.(jpg|jpeg|png)$/i))
                .map(f => path.join(inputPath, f));
        } else {
            // Einzelmodus
            filesToProcess = [inputPath];
        }
    } catch (e) {
        event.reply('analyse-ergebnis', { error: "Ungültiger Pfad" });
        return;
    }

    console.log(`Starte Batch mit ${filesToProcess.length} Bildern.`);
    let processedCount = 0;
    let allResults = [];

    // Funktion zur sequenziellen Abarbeitung (Rekursion oder Loop mit await)
    // Wir nehmen eine asynchrone Loop Funktion
    for (const imagePath of filesToProcess) {
        processedCount++;
        // Status an UI senden (optionales Feature, nutzen wir hier über console log oder erweitertes Event)
        // event.reply('status-update', `Verarbeite Bild ${processedCount} von ${filesToProcess.length}`);
        
        try {
            const result = await processSingleImage(imagePath);
            if (result && result.rects) {
                allResults.push(...result.rects);
            }
        } catch (err) {
            console.error(`Fehler bei ${imagePath}:`, err);
        }
    }

    // --- AUFRÄUMEN ---
    // Da wir im Batch-Modus temp_corrected.jpg immer wieder überschreiben,
    // löschen wir es am Ende einmalig.
    try {
        const tempFile = path.join(inputPath, "temp_corrected.jpg");
        if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
            console.log("Temporäre Datei gelöscht:", tempFile);
        }
    } catch (cleanupErr) {
        console.warn("Konnte temp_corrected.jpg nicht löschen:", cleanupErr);
    }

    // Fertig! Sende das Ergebnis (alle gesammelten Rects) an die UI zur Anzeige
    // Wir faken hier ein "Gesamtergebnis" Objekt
    event.reply('analyse-ergebnis', {
        image: filesToProcess[filesToProcess.length-1], // Zeige das letzte Bild als Hintergrund
        rects: allResults,
        crops_folder: "Batch abgeschlossen",
        isBatch: true,
        count: processedCount
    });
});

function processSingleImage(imagePath) {
    return new Promise((resolve, reject) => {
        let options = {
            mode: 'text',
            pythonPath: 'python', 
            scriptPath: __dirname,
            args: [imagePath]
        };

        PythonShell.run('detector.py', options).then(messages => {
            const resultString = messages[0];
            try {
                const data = JSON.parse(resultString);
                
                if (data.rects) {
                    data.rects.forEach(rect => {
                        processRect(rect);
                    });
                }
                resolve(data);
            } catch (e) {
                reject(e);
            }
        }).catch(err => {
            reject(err);
        });
    });
}

function processRect(rect) {
    try {
        // 1. Pfad prüfen
        if (!rect.crop_path || !fs.existsSync(rect.crop_path)) return;

        // 2. EXIF Daten vorbereiten
        let jsonString = "{}";
        let newFileName = "";

        if (rect.qr_data) {
            jsonString = JSON.stringify(rect.qr_data);
            
            // 3. Neuen Dateinamen generieren
            const d = rect.qr_data;
            // Reihenfolge: vorname_nachname_klasse_aufgabe
            // Wir filtern leere Teile raus
            const parts = [d.vorname, d.nachname, d.klasse, d.aufgabe].map(sanitize).filter(p => p.length > 0);
            
            if (parts.length > 0) {
                newFileName = parts.join("_") + ".jpg";
            }
        }

        // 4. EXIF schreiben
        const jpegData = fs.readFileSync(rect.crop_path).toString("binary");
        const exifObj = { "0th": {}, "Exif": {}, "GPS": {}, "Interop": {}, "1st": {}, "thumbnail": null };
        exifObj["Exif"][piexif.ExifIFD.UserComment] = jsonString;
        const exifBytes = piexif.dump(exifObj);
        const newJpegData = piexif.insert(exifBytes, jpegData);
        
        // Zurückspeichern
        const newJpegBuffer = Buffer.from(newJpegData, "binary");
        fs.writeFileSync(rect.crop_path, newJpegBuffer);

        // 5. Umbenennen (Wenn wir einen neuen Namen generiert haben)
        if (newFileName) {
            const dir = path.dirname(rect.crop_path);
            let newPath = path.join(dir, newFileName);

            // Konfliktlösung: Falls Datei schon existiert, Zähler anhängen
            let counter = 1;
            while (fs.existsSync(newPath)) {
                newPath = path.join(dir, newFileName.replace(".jpg", `_${counter}.jpg`));
                counter++;
            }

            fs.renameSync(rect.crop_path, newPath);
            
            // WICHTIG: Den Pfad im Rect-Objekt aktualisieren, damit die UI das Bild findet!
            rect.crop_path = newPath;
            rect.name = path.basename(newPath);
        }

    } catch (err) {
        console.error("Fehler bei Nachbearbeitung:", err);
    }
}