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

// NEU: Handler um Dateiliste zu holen (für Debug Blättern)
ipcMain.handle('get-files-in-folder', async (event, folderPath) => {
    try {
        const files = fs.readdirSync(folderPath);
        // Filtern nach Bildern und Sortieren
        return files.filter(f => f.match(/\.(jpg|jpeg|png)$/i)).sort();
    } catch (e) {
        console.error("Fehler beim Lesen des Ordners:", e);
        return [];
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

ipcMain.on('analysiere-bild', async (event, inputPath, options = {}) => {
    console.log("Input:", inputPath, "Options:", options);
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
    let lastData = null; // Speichert das letzte vollständige Ergebnis von Python

    // Funktion zur sequenziellen Abarbeitung (Rekursion oder Loop mit await)
    // Wir nehmen eine asynchrone Loop Funktion
    for (const imagePath of filesToProcess) {
        processedCount++;
        
        try {
            // Wir reichen das options Objekt weiter
            const result = await processSingleImage(imagePath, options);
            lastData = result; 
            if (result && result.rects) {
                allResults.push(...result.rects);
            }
        } catch (err) {
            console.error(`Fehler bei ${imagePath}:`, err);
        }
    }
    
    // ... REST DER FUNKTION BLEIBT GLEICH ...
    // (Achtung: Ich muss hier aufpassen, dass ich den Rest der Funktion nicht lösche beim Replacen)
    // Da "replace" Kontext braucht, passe ich processSingleImage separat an,
    // oder ich muss den ganzen Block ersetzen.
    
    // Da ich oben nur den Loop Body geändert habe, mache ich das unten weiter.
    // Aber warte, processSingleImage Signatur muss sich ändern.

    // --- AUFRÄUMEN ---
    try {
        let folderPath = inputPath;
        if (!fs.statSync(inputPath).isDirectory()) {
            folderPath = path.dirname(inputPath);
        }

        // NUR löschen wenn wir im echten Batch Modus sind
        if (filesToProcess.length > 1) {
            const tempFile = path.join(folderPath, "temp_corrected.jpg");
            if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
                console.log("Temporäre Datei gelöscht:", tempFile);
            }
        }
    } catch (cleanupErr) {
        console.warn("Konnte temp_corrected.jpg nicht löschen:", cleanupErr);
    }

    let finalImage = (lastData && lastData.image) ? lastData.image : filesToProcess[filesToProcess.length-1];

    event.reply('analyse-ergebnis', {
        image: finalImage,
        rects: allResults,
        debug_qrs: (lastData ? lastData.debug_qrs : []),
        crops_folder: (lastData ? lastData.crops_folder : "Batch"),
        isBatch: (filesToProcess.length > 1),
        count: processedCount
    });
});

function processSingleImage(imagePath, options = {}) {
    // Falls options nur ein boolean ist (Legacy support für alten Code, falls nötig, aber wir haben ja isDebug Flag)
    // Wir bauen options um, falls es nur "isDebug" war. 
    // Aber im Aufruf oben habe ich `const isDebug = options && options.isDebug` gemacht.
    // Daher übergebe ich jetzt das GANZE options Objekt an processSingleImage.
    
    // ACHTUNG: Ich muss die Signatur anpassen, da ich oben schon `processSingleImage(imagePath, isDebug)` aufgerufen habe?
    // Nein, oben habe ich `const result = await processSingleImage(imagePath, isDebug);` geändert?
    // NEIN, oben steht: `const isDebug = options && options.isDebug;` -> `processSingleImage(imagePath, isDebug);`
    // Ich ändere also die Signatur hier auf: (imagePath, isDebugOrOptions)
    
    // Aber sauberer: Ich ändere den Aufruf oben!
    
    return new Promise((resolve, reject) => {
        let pyArgs = [imagePath];
        
        let isDebug = false;
        let saveDebugCrops = false;

        // Argument Handling: Checken ob isDebugOrOptions ein Object oder Boolean ist
        if (typeof options === 'object') {
            isDebug = options.isDebug;
            saveDebugCrops = options.saveDebugCrops;
        } else {
            isDebug = options; // Fallback
        }

        if (isDebug) {
            pyArgs.push("DEBUG");
        }
        if (saveDebugCrops) {
            pyArgs.push("SAVE_CROPS");
        }

        let pyOptions = {
            mode: 'text',
            pythonPath: 'python', 
            scriptPath: __dirname,
            args: pyArgs
        };

        PythonShell.run('detector.py', pyOptions).then(messages => {
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