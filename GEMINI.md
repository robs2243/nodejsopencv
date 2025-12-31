# Node.js + OpenCV Document Scanner

## Project Overview

This project is a desktop application built with **Electron** and **Python (OpenCV)**. It functions as a document scanner and region extractor.

**Core Functionality:**
1.  **Image Ingestion:** Takes an input image (scan/photo of a document).
2.  **Perspective Correction:** Detects 4 specific "filled" markers (black squares) to align and warp the document into a flat top-down view.
3.  **Content Extraction:** Detects empty rectangular regions (checkboxes or text fields) within the corrected document.
4.  **Cropping:** Automatically crops these regions and saves them as individual image files (`ausschnitte/`).
5.  **Visualization:** Displays the corrected document with highlighted regions and a gallery of the extracted crops in the UI.

## Architecture

*   **Frontend/GUI:** Electron (HTML/JS) - Handles user input and visualization.
*   **Backend/Logic:** Python - Performs heavy image processing using OpenCV.
*   **Bridge:** `python-shell` - Enables communication between Node.js and the Python script.

## Prerequisites

Ensure you have the following installed:

1.  **Node.js** & **npm**
2.  **Python 3.x**
3.  **Python Dependencies:**
    ```bash
    pip install opencv-python numpy
    ```

## Installation

1.  Install Node.js dependencies:
    ```bash
    npm install
    ```

## Usage

### Running the Application

Since there is no `start` script defined in `package.json`, run the application using electron directly:

```bash
npx electron .
```

### Operation

1.  Enter the absolute path to a document image (e.g., `.jpg`) in the input field.
2.  Click **"Analysieren & Speichern"**.
3.  The Python script (`detector.py`) will process the image.
4.  The UI will update to show:
    *   The corrected "scanned" image with detected boxes outlined in green.
    *   A list of cropped images in the "Gespeicherte Ausschnitte" sidebar.

## Key Files

*   **`main.js`**: Electron entry point. Creates the window and handles the `analysiere-bild` IPC event. It spawns the Python process using `python-shell`.
*   **`detector.py`**: The image processing engine.
    *   **`four_point_transform`**: Corrects perspective based on 4 markers.
    *   **`is_contour_filled`**: Helper to distinguish between markers (filled) and content boxes (empty).
    *   **Output**: JSON string containing paths to the processed images and coordinate data.
*   **`index.html`**: The user interface. Uses HTML5 Canvas to draw the results and communicates with the main process via `ipcRenderer`.
*   **`package.json`**: Node.js configuration. Note: `electron` and `python-shell` are the key dependencies.

## Output

*   **`temp_corrected.jpg`**: The intermediate file showing the perspective-corrected document.
*   **`ausschnitte/`**: Directory where the individual cropped regions are saved (e.g., `ausschnitt_1.jpg`).
