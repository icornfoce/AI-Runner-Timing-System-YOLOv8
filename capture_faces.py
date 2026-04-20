import cv2
import os

def capture_faces():
    person_name = input("Enter the name of the person: ").strip()
    if not person_name:
        print("Name cannot be empty.")
        return

    save_path = os.path.join("Data", person_name)
    if not os.path.exists(save_path):
        os.makedirs(save_path)
        print(f"Created directory: {save_path}")

    cap = cv2.VideoCapture(0)
    count = 0
    
    print(f"Capturing photos for {person_name}...")
    print("Press 's' to save a photo.")
    print("Press 'q' to finish.")

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        cv2.imshow("Capture Faces - Press 's' to save, 'q' to quit", frame)
        
        key = cv2.waitKey(1) & 0xFF
        if key == ord('s'):
            img_name = f"{person_name}_{count}.jpg"
            img_path = os.path.join(save_path, img_name)
            cv2.imwrite(img_path, frame)
            print(f"Saved: {img_path}")
            count += 1
        elif key == ord('q'):
            break

    cap.release()
    cv2.destroyAllWindows()
    print(f"Finished capturing {count} photos for {person_name}.")

if __name__ == "__main__":
    capture_faces()
