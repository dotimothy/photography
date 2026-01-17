@echo off
setlocal

:: ==========================================
:: Configuration
:: ==========================================
set "PYTHON=python"
set "SCRIPT=preparePortfolio.py"
set "BUILD_DIR=build"
set "VENV=.venv"
set "VENV_PYTHON=%VENV%\Scripts\python.exe"

:: Default Values (equivalent to ?=)
set "quality=60"
set "jobs=0"
set "target=build"

:: ==========================================
:: Argument Parsing Logic
:: ==========================================
:parse_args
if "%~1"=="" goto :execute_target

:: Check if argument contains "=" (Variable assignment)
echo %~1 | findstr "=" >nul
if %errorlevel%==0 (
    set "%~1"
) else (
    set "target=%~1"
)
shift
goto :parse_args

:: ==========================================
:: Execution Router
:: ==========================================
:execute_target

if /i "%target%"=="all"       goto :all
if /i "%target%"=="build"     goto :build
if /i "%target%"=="install"   goto :install
if /i "%target%"=="fast"      goto :fast
if /i "%target%"=="exif"      goto :exif
if /i "%target%"=="clean"     goto :clean
if /i "%target%"=="deepclean" goto :deepclean
if /i "%target%"=="help"      goto :help

:: Unknown target
echo Unknown target: %target%
goto :help

:: ==========================================
:: Targets
:: ==========================================

:all
call :deepclean
call :build
goto :eof

:install
:: Check if activate script exists (Simple dependency check)
if exist "%VENV%\Scripts\activate.bat" goto :eof

echo Creating virtual environment...
if not exist "%VENV%" %PYTHON% -m venv %VENV%
"%VENV_PYTHON%" -m pip install --upgrade pip >nul
"%VENV_PYTHON%" -m pip install -r requirements.txt >nul
:: Update timestamp
copy /b "%VENV%\Scripts\activate.bat" +,, >nul 2>&1
goto :eof

:build
call :install
"%VENV_PYTHON%" %SCRIPT% --watermark --full-clean --quality %quality% --jobs %jobs%
goto :eof

:fast
call :install
"%VENV_PYTHON%" %SCRIPT% --skip-repo --quality %quality% --jobs %jobs%
goto :eof

:exif
call :install
"%VENV_PYTHON%" %SCRIPT% --exif
goto :eof

:clean
if exist "%BUILD_DIR%" rd /s /q "%BUILD_DIR%"
goto :eof

:deepclean
call :clean
if exist "%VENV%" rd /s /q "%VENV%"
if exist ".cache" rd /s /q ".cache"
if exist "tmp" rd /s /q "tmp"
if exist "logs" rd /s /q "logs"
goto :eof

:help
echo TheDoShoots Portfolio Makefile
echo ------------------------------------------
echo Usage: make [target] quality=[value]
echo.
echo make install   - Create venv and install dependencies
echo make build     - Run full build (auto-installs venv if missing)
echo make fast      - Run build without watermarking or git updates
echo make clean     - Remove build directory
echo make deepclean - Remove venv, logs folder, build dir, and cache
goto :eof