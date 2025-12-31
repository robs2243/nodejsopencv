const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { PythonShell } = require('python-shell');
const piexif = require('piexifjs');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,    // Erlaubt require in HTML (nur für einfache Tests)
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

// Hier hören wir auf den Befehl aus der HTML-Oberfläche
ipcMain.on('analysiere-bild', (event, imagePath) => {
    
    console.log("Starte Python für:", imagePath);

    let options = {
        mode: 'text',
        pythonPath: 'python', // Falls Python nicht im PATH ist, hier vollen Pfad zur exe angeben
        scriptPath: __dirname, // Wo liegt das Skript?
        args: [imagePath]      // Das übergeben wir an sys.argv[1]
    };

    PythonShell.run('detector.py', options).then(messages => {
        // messages ist ein Array von Strings (alle prints aus Python)
        // Wir nehmen das letzte print, das sollte unser JSON sein
        const resultString = messages[0]; 
        
        try {
            const data = JSON.parse(resultString);
            
            // --- NEU: QR Daten in die Bilder (EXIF) schreiben ---
            if (data.rects) {
                console.log("Verarbeite " + data.rects.length + " Ausschnitte...");

                data.rects.forEach(rect => {
                    try {
                        // Prüfen ob individuelle QR Daten von Python kamen
                        if (rect.qr_data) {
                            const cropPath = rect.crop_path;
                            
                            // JSON String erstellen
                            const jsonString = JSON.stringify(rect.qr_data);
                            console.log(`Schreibe EXIF für ${rect.name}:`, jsonString);

                            if (fs.existsSync(cropPath)) {
                                // 1. Bild laden
                                const jpegData = fs.readFileSync(cropPath).toString("binary");
                                
                                // 2. EXIF Objekt
                                const exifObj = {
                                    "0th": {},
                                    "Exif": {},
                                    "GPS": {},
                                    "Interop": {},
                                    "1st": {},
                                    "thumbnail": null
                                };
                                
                                // UserComment schreiben
                                exifObj["Exif"][piexif.ExifIFD.UserComment] = jsonString;

                                // 3. Bytes generieren und einfügen
                                const exifBytes = piexif.dump(exifObj);
                                const newJpegData = piexif.insert(exifBytes, jpegData);
                                
                                // 4. Speichern
                                const newJpegBuffer = Buffer.from(newJpegData, "binary");
                                fs.writeFileSync(cropPath, newJpegBuffer);
                            }
                        }
                    } catch (exifErr) {
                        console.error("Fehler beim Schreiben von EXIF für", rect.name, exifErr);
                    }
                });
            }

            // Sende das Ergebnis zurück ans Fenster
            event.reply('analyse-ergebnis', data);
        } catch (e) {
            console.error("Fehler beim Parsen von Python:", e);
        }
    }).catch(err => {
        console.error("Python Fehler:", err);
    });
});