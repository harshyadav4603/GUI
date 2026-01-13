# Geomechanics Elastic Parameter Calculator

Simple single-page app that parses CSV/XLSX well logs containing Depth, Density, Vp, Vs and computes elastic parameters.

Files:
- index.html – UI
- style.css – styles
- script.js – parsing, validation, calculations, plotting, export

Usage:
1. Open `index.html` in a modern browser.
2. Upload CSV or XLSX with columns for Depth (m), Density (kg/m^3), Vp (m/s), Vs (m/s).
3. Adjust column names if auto-detection differs.
4. Click "Validate & Compute" to produce table and plots.
5. Export results using CSV or XLSX buttons.

Backend mode:
- A minimal Flask backend is included to run server-side computation. To use it:
	1. Install Python 3.8+ and create a virtual environment.
	2. Install requirements:
```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```
	3. Run the backend:
```powershell
python backend.py
```
	4. In the UI check `Use backend compute` before uploading a file. The app will POST the file to `/api/compute` and return computed results.

Libraries used (CDN): PapaParse, SheetJS (xlsx), Plotly.js.

Notes:
- Assumes isotropic, linear-elastic material. Units must be SI for correct physical outputs.
- Vertical stress is computed by trapezoidal integration of density * g.

Additional computed parameters (added):
- `vp_vs_ratio`: Vp / Vs
- `impedance_gradient_per_m`: finite-difference gradient of acoustic impedance vs depth
- `delta_impedance_prev`: difference in acoustic impedance relative to previous sample (useful for reflectivity)
- `lambda_over_mu`: ratio of Lamé's lambda to shear modulus
- `poisson_from_moduli`: Poisson's ratio computed from bulk and shear moduli via nu = (3K - 2G) / (2*(3K + G))
- `brittleness_e`: simple normalized brittleness index based on Young's modulus (0..1)
