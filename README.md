# 📷 TheDoShoots Photography Portfolio 📷
Welcome to my photography portfolio: **TheDoShoots**! Here is how you build my website.

This project automates the creation of gallery pages based on a template repository and provides tools for managing image metadata.

Live Site: https://thedoshoots.me

## ✨ Features

- **Automated Gallery Generation**: Scripts to clone a base template and populate it with your specific gallery content.
- **EXIF Modification Tool**: Integrated Flask-based web app to ease the process of modifying image EXIF data.
- **Customizable Portfolio**:
    - **Gallery Mode**: Standard viewing experience.
    - **Data Saver Mode**: Optimized for slower connections.
    - **Direct Links**: Option to open images directly.
    - **Auto Fullscreen**: Immersive viewing.
    - **Immersive Viewer**: Deep-zoom capability for high-res images.
    - **Custom Settings**: Persisted user preferences via local storage.
- **Responsive Design**: Works across desktop and mobile devices.

## 🚀 Getting Started

### Prerequisites

- **Python 3.x**
- **Git**

### Installation

Install the required Python packages. You can install them via pip:
   ```bash
   pip install -r requirements.txt
   ```

## 🛠 Usage

### Building the Portfolio

To build your galleries (e.g., Astronomy, Wildlife) from the template, run the main script:

```bash
python preparePortfolio.py
```

This will:
1. Clone/Update the base gallery template from `https://github.com/dotimothy/gallery.git`.
2. Generate the specific gallery directories (`astronomy`, `wildlife`) with the correct titles and configurations.

### EXIF Modification Tool

If you need to modify the EXIF data of your images (specifically for the "fulls" directory in a gallery), you can launch the helper tool:

```bash
python preparePortfolio.py --exif
```

- This launches a local Flask server.
- Follow the on-screen prompts to open the web interface.
- **Note**: The script waits for the server to be ready and attempts to open your browser automatically.

### Command Line Options

| Argument | Description |
| :--- | :--- |
| `--quality`/`-q` | **[NEW]** Set JPEG quality (1-100) for watermarked images and thumbnails. Default: `100`. |
| `--jobs`/`-j` | Set number of parallel workers for faster processing. |
| `--clean` | Wipe generated assets (keeps images). |
| `--full-clean` | Wipe everything including downloaded porfolio images. |
| `--dry-run` | Simulate the build process without making changes. |
| `--watermark` | Apply watermark to images. |
| `--select` | Build only specific galleries (e.g. `--select astronomy`). |

## 📂 Project Structure

- **`preparePortfolio.py`**: The main orchestration script. Handles fetching the template and generating site sections.
- **`index.html`**: The main landing page of the portfolio.
- **`astronomy/`, `wildlife/`**: Dedicated directories for each photo category.
    - Contains the generated `index.html` for the gallery.
    - Stores the `fulls/` directory where high-resolution images are kept.
    - Includes the `prepareSite.py` script for gallery-specific operations.
- **`assets/photographer.jpg`**: Profile picture used on the landing page.

## ⚙️ Settings

The portfolio site (`index.html`) includes a built-in settings panel (gear icon) allowing visitors to toggle:
- Gallery Mode
- Data Saver Mode
- Auto Fullscreen
- Direct Links
- Gallery Transition Duration

## 📝 License

### Dual Licensing

This repository uses a dual licensing structure to clearly define the terms for the source code versus the photographic content. This repository contains two distinct categories of content, each governed by its own license:

| Component | Purpose | License | Key Permissions Granted |
| :--- | :--- | :--- | :--- |
| **Photographic Content** (Images) | The original creative work (the photography). | **CC BY-NC-ND 4.0** | Users can share the photos with credit, but **cannot modify them** (No-Derivatives) and **cannot use them commercially**. |
| **Source Code** (`.py`, `.html`, etc.) | The underlying automation and site structure. | **MIT License** | Users can freely use, modify, and distribute the code for any purpose, with attribution. |

**Photographic Content License Details:**

All photographs in this portfolio are the original work of **Timothy Do** and are licensed under the **Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International Public License (CC BY-NC-ND 4.0)**.

© 2026 Timothy Do. All Rights Reserved.

See the `LICENSE` file in this repository for the full legal text.

## 📬 Contact

Timothy Do - [@dotimothy](https://github.com/dotimothy) on GitHub
