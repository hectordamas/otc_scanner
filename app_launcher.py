import os
import sys
import time
import socket
import threading
import uvicorn
import webview
import ctypes

# Asignar AppUserModelID explícito en Windows para agrupar y anclar la aplicación correctamente en la barra de tareas
if sys.platform == 'win32':
    try:
        myappid = 'otcscanner.app.v1.0'
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(myappid)
    except Exception:
        pass

# Asegurar que el directorio raíz del proyecto esté en sys.path
BASE_DIR = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from api.index import app

class UvicornServerThread(threading.Thread):
    def __init__(self, host="127.0.0.1", port=8000):
        super().__init__()
        self.host = host
        self.port = port
        self.config = uvicorn.Config(
            app=app,
            host=self.host,
            port=self.port,
            log_level="warning",
            access_log=False
        )
        self.server = uvicorn.Server(self.config)
        self.daemon = True

    def run(self):
        try:
            self.server.run()
        except Exception as e:
            print(f"Error al iniciar el servidor backend: {e}")

    def stop(self):
        self.server.should_exit = True

def wait_for_server(host="127.0.0.1", port=8000, timeout=5.0):
    start_time = time.time()
    while time.time() - start_time < timeout:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except (OSError, ConnectionRefusedError):
            time.sleep(0.1)
    return False

def main():
    port = 8000
    host = "127.0.0.1"

    print("Iniciando OTC Scanner Pro (Servidor Local)...")

    # Iniciar servidor FastAPI/Uvicorn en segundo plano
    server_thread = UvicornServerThread(host=host, port=port)
    server_thread.start()

    # Esperar a que el servidor responda en el puerto local
    if wait_for_server(host, port):
        print(f"Servidor backend listo en http://{host}:{port}")
    else:
        print("Advertencia: El servidor tardó más de lo esperado en responder.")

    # Ruta del icono para la ventana
    icon_path = os.path.join(BASE_DIR, "icon.ico")

    # Crear ventana nativa de escritorio
    window = webview.create_window(
        title="OTC Scanner Pro",
        url=f"http://{host}:{port}",
        width=1366,
        height=850,
        resizable=True,
        min_size=(1024, 700),
        background_color="#0b0e14"
    )

    # Iniciar la interfaz gráfica (esta llamada bloquea hasta que el usuario cierra la ventana)
    webview.start(private_mode=False, icon=icon_path if os.path.exists(icon_path) else None)

    # Al cerrar la ventana, detener el servidor backend y forzar la salida
    print("Ventana cerrada por el usuario. Apagando servidor local y finalizando programa...")
    try:
        server_thread.stop()
    except Exception:
        pass

    # Salida forzada limpia para cerrar websockets, hilos y liberar puerto 8000
    os._exit(0)

if __name__ == "__main__":
    main()
