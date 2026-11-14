# Field Shift - NASA Space Apps Challenge 2026

An institutional-grade decision-support system for Greek farmers to evaluate climate shifts, model daily soil water balances, and optimize crop rotation paths using NASA Earth telemetry and SoilGrids datasets.

---

## Tech Stack

- **Frontend:** React + Vite + TypeScript + Tailwind CSS
- **Database & Auth:** Supabase (PostgreSQL + PostGIS, Row Level Security enabled)
- **Icons:** Lucide React
- **Scientific Core Engine (Upcoming):** Python + FastAPI (`core/`)

---

## Getting Started (Collaborator Workflow)

Follow these steps to set up and run the application locally on your machine after cloning the repository.

### Prerequisites
Make sure you have installed:
- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- `git`
- Python 3.10+ (Optional, for backend/core engine developers)

---

### Step 1: Clone the Repository

Open your terminal and clone the repository:

```bash
git clone https://github.com/Christos7605/fieldshift.git
cd fieldshift
```

---

### Step 2: Navigate to the Frontend Workspace

All web application code is located inside the `web/` directory:

```bash
cd web
```

---

### Step 3: Install Dependencies

Optionally set a venv before installing all required packages via (Windows / Powershell / cmd):

```bash
python -m venv venv
.\venv\Scripts\activate
```

Install all required packages (`react`, `@supabase/supabase-js`, `lucide-react`, Tailwind CSS, etc.):

```bash
npm install
```

---

### Step 4: Configure Environment Variables

Create a new local environment file named `.env.local` inside the `web/` folder:

- **File Path:** `web/.env.local`

Add the shared Supabase project credentials inside `web/.env.local`:

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_ARCGIS_API_KEY=
```

---

### Step 5: Start the Local Development Server

Run the Vite development server:

```bash
npm run dev
```

Vite will start the server and output a local URL (typically `http://localhost:5173`). Open this link in your web browser.

---

## Repository Structure

```text
fieldshift/
├── web/                  # React + Vite Frontend
│   ├── src/
│   │   ├── components/   # Reusable UI Components & Protected Routes
│   │   ├── context/      # AuthContext & Supabase State
│   │   ├── lib/          # Supabase Client Initialization
│   │   ├── pages/        # Home, Login, Register, Dashboard, Profile
│   │   ├── App.tsx       # Router Configuration
│   │   └── index.css     # Agricultural Styling System & Custom Variables
│   └── .env.local        # Local Environment Variables (Ignored by Git)
├── core/                 # Scientific Python Modeling Engine (In Progress)
└── README.md
```

---