@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set PORT=8080

where py >nul 2>nul
if not errorlevel 1 (
  start "AI Court Server" cmd /k "cd /d ""%~dp0"" && py -m http.server %PORT%"
  goto open
)

where python >nul 2>nul
if not errorlevel 1 (
  start "AI Court Server" cmd /k "cd /d ""%~dp0"" && python -m http.server %PORT%"
  goto open
)

where python3 >nul 2>nul
if not errorlevel 1 (
  start "AI Court Server" cmd /k "cd /d ""%~dp0"" && python3 -m http.server %PORT%"
  goto open
)

echo.
echo [AI COURT] Python не найден.
echo Установите Python или откройте папку через Live Server в VS Code.
echo.
pause
exit /b 1

:open
timeout /t 2 /nobreak >nul
start "" "http://localhost:%PORT%/index.html"
start "" "http://localhost:%PORT%/teacher.html"
echo AI Court запущен: http://localhost:%PORT%/
exit /b 0
