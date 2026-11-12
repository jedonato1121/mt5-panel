@echo off
rem Start the panel from wherever this file lives.
cd /d "%~dp0"
node server\index.js
