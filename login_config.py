"""
Configuracion de login para otc_scanner.

- Si USE_INTERACTIVE_LOGIN = False, el programa usa FIXED_EMAIL/FIXED_PASSWORD.
- Si USE_INTERACTIVE_LOGIN = True, el programa pedira email y contrasena por consola.

Sugerencia para compartir el script:
- Cambia USE_INTERACTIVE_LOGIN a True antes de entregarlo.
"""

import os

# Cargar variables de entorno desde el archivo .env si existe
env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
if os.path.exists(env_path):
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, val = line.split("=", 1)
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                os.environ[key] = val

# Leer credenciales de las variables de entorno
FIXED_EMAIL = os.environ.get("IQ_EMAIL", "").strip()
FIXED_PASSWORD = os.environ.get("IQ_PASSWORD", "").strip()

# Si las credenciales están configuradas en .env o en el entorno del sistema, no pedir login interactivo
if FIXED_EMAIL and FIXED_PASSWORD:
    USE_INTERACTIVE_LOGIN = False
else:
    USE_INTERACTIVE_LOGIN = True

