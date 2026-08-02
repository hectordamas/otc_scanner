Set WshShell = CreateObject("WScript.Shell")
strDesktop = WshShell.SpecialFolders("Desktop")

' Acceso directo en el Escritorio
Set oShortcutDesktop = WshShell.CreateShortcut(strDesktop & "\OTC Scanner Pro.lnk")
oShortcutDesktop.TargetPath = "e:\Proyectos en Curso\otc_scanner\dist\OTC_Scanner\OTC_Scanner.exe"
oShortcutDesktop.WorkingDirectory = "e:\Proyectos en Curso\otc_scanner\dist\OTC_Scanner"
oShortcutDesktop.IconLocation = "e:\Proyectos en Curso\otc_scanner\icon.ico"
oShortcutDesktop.Save

' Acceso directo en la raíz del proyecto
Set oShortcutProject = WshShell.CreateShortcut("e:\Proyectos en Curso\otc_scanner\OTC Scanner Pro.lnk")
oShortcutProject.TargetPath = "e:\Proyectos en Curso\otc_scanner\dist\OTC_Scanner\OTC_Scanner.exe"
oShortcutProject.WorkingDirectory = "e:\Proyectos en Curso\otc_scanner\dist\OTC_Scanner"
oShortcutProject.IconLocation = "e:\Proyectos en Curso\otc_scanner\icon.ico"
oShortcutProject.Save

WScript.Echo "Acceso directo creado con exito."
