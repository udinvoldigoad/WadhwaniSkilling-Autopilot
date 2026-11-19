@echo off
title Bot Wadhwani - jangan ditutup
cd /d "%~dp0"
if not exist node_modules (
  echo node_modules belum ada, menjalankan npm i...
  call npm i || goto err
  call npx playwright install chromium || goto err
)
node node_modules\tsx\dist\cli.mjs src\panel.ts
if errorlevel 1 goto err
exit /b 0
:err
echo.
echo Panel gagal jalan. Baca pesan di atas.
pause
