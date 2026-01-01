import cv2
import numpy as np
import sys
import json
import os
from pyzbar.pyzbar import decode

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
    
    # Standard Ordner Name
    crops_folder_name = "ausschnitte"
    
    # Prüfen auf DEBUG Flag
    if len(sys.argv) > 2 and sys.argv[2] == "DEBUG":
        crops_folder_name = "debug"

    # Ordner für die Ausschnitte erstellen
    crops_dir = os.path.join(folder_path, crops_folder_name)
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

    # --- QR Codes im (entzerrten) Bild suchen und Lokalisieren (GLOBALER SCAN) ---
    global_qr_data = {} 
    local_qrs = []      
    debug_qrs = []      

    try:
        decoded_objects = decode(final_image)
        for obj in decoded_objects:
            qr_text = obj.data.decode("utf-8")
            if qr_text:
                r = obj.rect
                # Debug Info speichern
                debug_qrs.append({
                    "x": r.left, "y": r.top, "width": r.width, "height": r.height,
                    "text": qr_text
                })

                try:
                    data = json.loads(qr_text)
                    # Wir speichern top (y) und left (x) für die geometrische Regel
                    if "aufgabe" in data:
                        local_qrs.append({
                            "data": data, 
                            "y": r.top, 
                            "x": r.left,
                            "w": r.width,
                            "h": r.height
                        })
                    else:
                        global_qr_data.update(data)
                except:
                    pass
                
    except Exception as qr_e:
        pass
    
    # Rechtecke im (neuen) Bild suchen
    gray_final = cv2.cvtColor(final_image, cv2.COLOR_BGR2GRAY)
    _, thresh_final = cv2.threshold(gray_final, 80, 255, cv2.THRESH_BINARY_INV)
    contours_content, _ = cv2.findContours(thresh_final, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    # Sortieren von oben nach unten
    contours_content = sorted(contours_content, key=lambda c: cv2.boundingRect(c)[1])

    rects = []
    img_h, img_w = final_image.shape[:2]
    crop_counter = 1

    for cnt in contours_content:
        x, y, w, h = cv2.boundingRect(cnt)
        
        # Filter
        is_too_big = w > (img_w * 0.9)
        is_edge = x < 5 or y < 5 or (x+w) > (img_w-5) or (y+h) > (img_h-5)

        if w > 20 and h > 20 and not is_too_big and not is_edge:
            if not is_contour_filled(cnt, thresh_final):
                
                # AUSSCHNEIDEN
                margin = 10
                roi = final_image[y+margin : y+h-margin, x+margin : x+w-margin]
                
                if roi.size > 0:
                    base_name = os.path.splitext(os.path.basename(image_path))[0]
                    filename = f"{base_name}_crop_{crop_counter}.jpg"
                    
                    save_path = os.path.join(crops_dir, filename)
                    cv2.imwrite(save_path, roi)
                    
                    # --- MATCHING & RESCUE SCAN ---
                    found_local_data = {}
                    
                    # 1. Prüfen: Haben wir schon einen passenden QR-Code in der globalen Liste?
                    # Regel: QR Oberkante (qr.y) ist ca. 150px über Rechteck Oberkante (y)
                    # Toleranz: +/- 30px
                    target_qr_y = y - 150
                    y_tolerance = 30
                    
                    best_match = None
                    
                    for lqr in local_qrs:
                        # Vertikale Prüfung
                        dist_y = abs(lqr["y"] - target_qr_y)
                        
                        # Horizontale Prüfung (grob überlappend oder nah dran)
                        # Mitte des Rechtecks vs Mitte des QR
                        rect_cx = x + w / 2
                        qr_cx = lqr["x"] + lqr["w"] / 2
                        dist_x = abs(rect_cx - qr_cx)
                        
                        # Wir erlauben vertikal 30px Toleranz und horizontal, 
                        # dass er nicht weiter weg ist als die halbe Breite + Puffer
                        if dist_y <= y_tolerance and dist_x < (w + 100):
                            best_match = lqr
                            break # Den ersten passenden nehmen
                    
                    if best_match:
                        found_local_data = best_match["data"]
                    
                    else:
                        # 2. RESCUE SCAN: Kein QR gefunden? Vielleicht zu blass!
                        # Wir schneiden den erwarteten Bereich aus und verstärken den Kontrast.
                        
                        # ROI definieren: Wir suchen ca. bei y-150. 
                        # Nehmen wir y-220 bis y-80 als Fenster.
                        roi_y1 = max(0, y - 220)
                        roi_y2 = max(0, y - 80)
                        roi_x1 = max(0, x - 20)      # Etwas breiter als das Feld
                        roi_x2 = min(img_w, x + w + 20)
                        
                        rescue_roi = final_image[roi_y1:roi_y2, roi_x1:roi_x2]
                        
                        if rescue_roi.size > 0:
                            # Bildverbesserung: Graustufen + CLAHE (Contrast Limited Adaptive Histogram Equalization)
                            gray_rescue = cv2.cvtColor(rescue_roi, cv2.COLOR_BGR2GRAY)
                            clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8,8))
                            enhanced_roi = clahe.apply(gray_rescue)
                            
                            # Nur zum Debuggen: Man könnte enhanced_roi hier speichern um zu sehen was er sieht
                            # cv2.imwrite(os.path.join(crops_dir, f"debug_rescue_{crop_counter}.jpg"), enhanced_roi)

                            try:
                                rescue_decoded = decode(enhanced_roi)
                                for r_obj in rescue_decoded:
                                    r_text = r_obj.data.decode("utf-8")
                                    if r_text:
                                        # Gefunden!
                                        try:
                                            r_data = json.loads(r_text)
                                            found_local_data = r_data
                                            
                                            # WICHTIG: Zur Debug-Liste hinzufügen, damit man den orangen Rahmen sieht!
                                            # Koordinaten müssen zurückgerechnet werden auf das Gesamtbild
                                            rr = r_obj.rect
                                            debug_qrs.append({
                                                "x": roi_x1 + rr.left,
                                                "y": roi_y1 + rr.top,
                                                "width": rr.width,
                                                "height": rr.height,
                                                "text": r_text + " (RESCUED!)"
                                            })
                                            break # Nur den ersten nehmen
                                        except:
                                            pass
                            except:
                                pass

                    # Kombiniere Global + Lokal (egal ob normal gefunden oder rescued)
                    merged_data = global_qr_data.copy()
                    merged_data.update(found_local_data)
                    
                    rects.append({
                        "x": x, "y": y, "width": w, "height": h,
                        "crop_path": save_path,
                        "name": filename,
                        "qr_data": merged_data
                    })
                    crop_counter += 1

    # Response aufbereiten: Pfade für JSON/JS anpassen (Slashes statt Backslashes)
    rects_fixed = []
    for r in rects:
        r["crop_path"] = r["crop_path"].replace("\\", "/")
        rects_fixed.append(r)
        
    response = {
        "image": display_image_path.replace("\\", "/"),
        "rects": rects_fixed,
        "crops_folder": crops_dir.replace("\\", "/"),
        "debug_qrs": debug_qrs
    }
    print(json.dumps(response))

except Exception as e:
    print(json.dumps({"error": str(e)}))