import cv2
import numpy as np
import sys
import json
import os

# --- HILFSFUNKTIONEN ---
def order_points(pts):
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    return rect

def four_point_transform(image, pts):
    rect = order_points(pts)
    (tl, tr, br, bl) = rect
    widthA = np.sqrt(((br[0] - bl[0]) ** 2) + ((br[1] - bl[1]) ** 2))
    widthB = np.sqrt(((tr[0] - tl[0]) ** 2) + ((tr[1] - tl[1]) ** 2))
    maxWidth = max(int(widthA), int(widthB))
    heightA = np.sqrt(((tr[0] - br[0]) ** 2) + ((tr[1] - br[1]) ** 2))
    heightB = np.sqrt(((tl[0] - bl[0]) ** 2) + ((tl[1] - bl[1]) ** 2))
    maxHeight = max(int(heightA), int(heightB))
    dst = np.array([[0, 0], [maxWidth - 1, 0], [maxWidth - 1, maxHeight - 1], [0, maxHeight - 1]], dtype="float32")
    M = cv2.getPerspectiveTransform(rect, dst)
    warped = cv2.warpPerspective(image, M, (maxWidth, maxHeight))
    return warped

def is_contour_filled(contour, binary_image):
    mask = np.zeros(binary_image.shape, dtype="uint8")
    cv2.drawContours(mask, [contour], -1, 255, -1)
    mean_val = cv2.mean(binary_image, mask=mask)[0]
    return mean_val > 128 

# --- HAUPTPROGRAMM ---
try:
    image_path = sys.argv[1]
    folder_path = os.path.dirname(image_path)
    
    # Ordner für die Ausschnitte erstellen
    crops_dir = os.path.join(folder_path, "ausschnitte")
    if not os.path.exists(crops_dir):
        os.makedirs(crops_dir)

    # Pfad für das entzerrte Gesamtbild
    temp_output_path = os.path.join(folder_path, "temp_corrected.jpg")

    img = cv2.imread(image_path)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 80, 255, cv2.THRESH_BINARY_INV)
    
    # Marker suchen
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled_markers = []
    for cnt in contours:
        if cv2.contourArea(cnt) > 100 and is_contour_filled(cnt, thresh):
            filled_markers.append(cnt)

    filled_markers = sorted(filled_markers, key=cv2.contourArea, reverse=True)[:4]

    final_image = img
    display_image_path = image_path 

    # Warping (wenn 4 Marker da sind)
    if len(filled_markers) == 4:
        pts = []
        for c in filled_markers:
            M = cv2.moments(c)
            if M["m00"] != 0:
                pts.append([int(M["m10"] / M["m00"]), int(M["m01"] / M["m00"])])
        
        final_image = four_point_transform(img, np.array(pts, dtype="float32"))
        cv2.imwrite(temp_output_path, final_image)
        display_image_path = temp_output_path

    # Rechtecke im (neuen) Bild suchen
    gray_final = cv2.cvtColor(final_image, cv2.COLOR_BGR2GRAY)
    _, thresh_final = cv2.threshold(gray_final, 80, 255, cv2.THRESH_BINARY_INV)
    contours_content, _ = cv2.findContours(thresh_final, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    # WICHTIG: Sortieren! Wir wollen die Rechtecke von oben nach unten abarbeiten
    # boundingBox liefert (x, y, w, h). Wir sortieren nach y (Index 1)
    contours_content = sorted(contours_content, key=lambda c: cv2.boundingRect(c)[1])

    rects = []
    img_h, img_w = final_image.shape[:2]
    crop_counter = 1

    for cnt in contours_content:
        x, y, w, h = cv2.boundingRect(cnt)
        
        # Filter (Größe und Randabstand)
        is_too_big = w > (img_w * 0.9)
        is_edge = x < 5 or y < 5 or (x+w) > (img_w-5) or (y+h) > (img_h-5)

        if w > 20 and h > 20 and not is_too_big and not is_edge:
            if not is_contour_filled(cnt, thresh_final):
                
                # --- DAS IST NEU: AUSSCHNEIDEN & SPEICHERN ---
                
                # Numpy Slicing: Bild[y_start:y_ende, x_start:x_ende]
                # Wir geben noch +/- 2 Pixel Rand weg, damit der schwarze Rahmen nicht mit drauf ist
                roi = final_image[y+2 : y+h-2, x+2 : x+w-2]
                
                if roi.size > 0: # Sicherheitscheck
                    filename = f"ausschnitt_{crop_counter}.jpg"
                    save_path = os.path.join(crops_dir, filename)
                    cv2.imwrite(save_path, roi)
                    
                    rects.append({
                        "x": x, "y": y, "width": w, "height": h,
                        "crop_path": save_path, # Wir merken uns den Pfad
                        "name": filename
                    })
                    crop_counter += 1

    response = {
        "image": display_image_path,
        "rects": rects,
        "crops_folder": crops_dir
    }
    print(json.dumps(response))

except Exception as e:
    print(json.dumps({"error": str(e)}))