# PCB ReTrace

**Digitize, document, reverse engineer, and generate schematics for printed circuit boards entirely in your browser.**

[**Launch PCB ReTrace**](https://pcb.etaras.com/studio.html) | [**Examples Gallery**](https://dev-lab.github.io/pcb-retrace-examples/)

---

## 🔍 Overview
**PCB ReTrace** is a local-first web application designed for electronics engineers, repair technicians, and hardware hackers. It helps you move from a physical PCB to a digital representation using only photographs.

It runs 100% client-side using HTML5, Vanilla JS, and WebAssembly. **No data is ever uploaded to a server.**

## ✨ Key Features

* **BOM Management:** Map components on board photos to a digital Bill of Materials.
* **Visual Inspection:** View multiple board layers (Top/Bottom) simultaneously.
* **Computer Vision Stitching:** Automatically align close-up macro shots with wide-angle reference photos using OpenCV.
* **X-Ray View:** Manually stitch Top and Bottom images to trace vias and through-holes across layers.
* **Netlist Tracing:** Click-to-trace connectivity and export to **KiCad** compatible netlists (`.net`) and SPICE netlists (`.cir`).
* **Schematic Generation (Schema ReTrace):** Generate and route schematic diagrams from traced nets.
  * **Interactive Editing:** Drag components, rotate them, and replace symbols.
  * **KiCad Libraries:** Import `.kicad_sym` libraries or ZIP archives to assign standard symbols to components.
  * **KiCad Schematic Export:** Export a generated schematic diagram to a **KiCad** compatible format (`.kicad_sch`).
* **Integrated Tools:**
  * Resistor Color Code Decoder (3-6 bands)
  * Inductor Color Code Decoder
  * Air-core Coil Calculator
* **Privacy First:** All data is stored in your browser's IndexedDB.

## 🚀 Getting Started

### Online
Simply visit the [GitHub Pages deployment](https://dev-lab.github.io/pcb-retrace/).

### Offline / Local Development
Since the project uses no build tools, you can run it directly from the source:

1. Clone this repository:
   ```bash
   git clone https://github.com/dev-lab/pcb-retrace.git
   ```
2. Navigate to the `docs` folder (where the source code lives):
   ```bash
   cd pcb-retrace/docs
   ```
3. Open `index.html` in your browser.
   * *Note: Some features (like Camera access) require a secure context (HTTPS) or `localhost`. For best results, use a simple local server like Python's `http.server`.*

## 🔗 Sharing & Deep Links

You can easily share a reverse-engineered device setup by hosting an exported ZIP file on a public server (like GitHub Pages) and creating a deep link. 

Append `?import={URL}` to the studio address:
`https://pcb.etaras.com/studio.html?import=https://example.com/my-device.zip`

*(Note: The hosting server must support CORS by sending the `Access-Control-Allow-Origin: *` header).*

## 📂 Project Structure

This project follows a "Build-Free" architecture. All source code is located in the `/docs` folder to support GitHub Pages directly.

* `docs/studio.html`: The main application entry point.
* `docs/schema.html`: Standalone schematic generation and netlist visualization.
* `docs/guide.html`: PCB ReTrace User Guide.
* `docs/resistor.html`: Resistor Color Code Decoder.
* `docs/inductor.html`: Inductor Color Code Decoder.
* `docs/coil.html`: Air-core Coil Calculator.

## ⚖️ License & Commercial Use

This project is **Dual Licensed**:

1. **Open Source (AGPLv3):** Ideal for hobbyists, educational use, and open-source projects. You are free to use and modify the software, provided that any modifications are also made open source under the same terms.
2. **Commercial License:** For proprietary use, internal corporate deployment without copyleft restrictions, or integration into closed-source workflows, a commercial license is available.

Please see [LICENSE](LICENSE) for details.

For commercial licensing inquiries, please contact: Taras Greben <taras.greben@gmail.com>.

## 📦 Third-Party Libraries

* **OpenCV.js:** Computer Vision (Apache 2.0 License)
* **zip.js:** File compression/decompression (BSD 3-Clause License)
* **WireBender:** Schematic generation/routing library (AGPLv3 or Commercial)
* **Adaptagrams:** Used by WireBender via `libavoid`, `libcola`, and `libvpsc` (LGPL 2.1 or later)
* **KiCad symbol libraries:** Redistributed symbol data bundled as `assets/kicad-symbols-master.zip`

See [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) for full text.
