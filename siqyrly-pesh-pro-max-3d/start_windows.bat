@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .env (
  echo [INFO] Please make a copy of .env.example as .env and set your own TEACHER_PASSWORD.
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Please install Node.js LTS from nodejs.org.
  pause
  exit /b 1
)
echo Open http://localhost:3000 in your browser
node server.js
pause
