const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { PythonShell } = require('python-shell');

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
            // Sende das Ergebnis zurück ans Fenster
            event.reply('analyse-ergebnis', data);
        } catch (e) {
            console.error("Fehler beim Parsen von Python:", e);
        }
    }).catch(err => {
        console.error("Python Fehler:", err);
    });
});