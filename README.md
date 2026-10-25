# 🖐️ HandFlow — Hand Gesture Mouse & Browser Controller (Chrome Extension)

Control your mouse cursor and Chrome browser completely hands-free using your webcam and on-device MediaPipe Hand Tracking (`@mediapipe/tasks-vision`).

---

## ✨ Features & Supported Hand Gestures

| Gesture | Hand Posture | Action |
| :--- | :--- | :--- |
| **Move Cursor** | `☝️` Index finger extended | Smooth virtual cursor with **1-Euro adaptive filtering** & **Magnetic Target Snap** |
| **Left Click** | `🤏` Quick pinch (Thumb + Index tip) | Clicks buttons, links, checkboxes, and focuses text inputs |
| **Double Click** | `🤏x2` Two quick pinches (`< 440ms`) | Fires `dblclick` (e.g., fullscreen video or word selection) |
| **Drag & Drop / Sliders** | `🤏⏳` Pinch & hold (`> 340ms`) + move | Drags elements, selects text, and scrubs `<input type="range">` sliders |
| **Right Click & Action Wheel** | `👌` Pinch Thumb + Middle tip (or `🤘` Rock sign) | Dispatches `contextmenu` and opens the **8-Slice Radial Quick Action Wheel** |
| **Smooth Scroll** | `✌️` Peace sign (Index + Middle extended) | Scrolls the scrollable container under the cursor (or page) vertically & horizontally |
| **Switch Tabs** | `🖐️` 3-Finger or Open-Palm horizontal swipe | Swipe Left = **Previous Tab**, Swipe Right = **Next Tab** |
| **Mouse Clutch (Pause Cursor)** | `✊` Closed Fist | Freezes cursor position so you can reposition your hand (like lifting a physical mouse) |
| **Media Play / Pause** | `✊⏳` Hold Closed Fist for `1.1s` | Plays or pauses `<video>` / `<audio>` elements on the active page |
| **Page Zoom In / Out** | `🤙` Shaka sign (Thumb + Pinky) move Up/Down | Zooms the active browser tab in or out |
| **Dwell Auto-Click** | Hover steady for `1.0s` (optional toggle) | Hands-free auto-click without pinching |

---

## 🚀 How to Install in Chrome (30 Seconds)

1. Open Google Chrome and navigate to:
   ```text
   chrome://extensions
   ```
2. Turn ON **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** (top-left button).
4. Select this folder:
   ```text
   c:\Users\Avvari\OneDrive\Desktop\handgest
   ```
5. The **HandFlow Setup & Gesture Sandbox** tab will open automatically. Click **"📷 Grant Camera Access & Start"** once to grant camera permission to the extension.
6. Visit any website (or open the **Persistent Side Panel** from the HandFlow toolbar popup for uninterrupted cross-tab tracking) and control Chrome with your hand!
   - **Keyboard Shortcut**: Press `Alt + Shift + H` anytime to toggle hand tracking ON or OFF.
