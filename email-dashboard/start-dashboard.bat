@echo off
cd /d "%~dp0"
start "" http://localhost:3777
node server.js
pause
