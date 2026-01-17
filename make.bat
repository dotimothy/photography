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

:: Variable Defaults (equivalent to ?=)
:: You can override these by setting them before running the script
:: Example: set quality=80 && make.bat build
if not defined quality set "quality=60"
if not defined jobs set "jobs=0"

:: ==========================================
:: Main Logic / Argument Parsing
:: ==========================================

:: If no argument is provided, go to default (build)
if "%~1"=="" goto :build

:: Switch case for targets
if /i "%~1"=="all"       goto :all
if /i "%~1"=="build"     goto :build
if /i "%~1"=="install"   goto :install
if /i "%~1"=="fast"      goto :fast
if /i "%~1"=="exif"      goto :exif
if /i "%~1"=="clean"     goto :clean
if /i "%~1"=="deepclean" goto :deepclean
if /i "%~1"=="help"      goto :help

:: If unknown target
echo Unknown target: %~1
goto :help

:: ==========================================
:: Targets
:: ==========================================

:all
call :deepclean
call :build
goto :eof

:install
:: Check if venv exists to mimic Makefile dependency checking
if exist "%VENV%\Scripts\activate.bat" (
    exit /b 0
)
echo Creating virtual environment...
if not exist "%VENV%" %PYTHON% -m venv %VENV%
"%VENV_PYTHON%" -m pip install --upgrade pip
"%VENV_PYTHON%" -m pip install -r requirements.txt
:: "touch" equivalent to update timestamp
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
echo TheDoShoots Portfolio Batch Script
echo ------------------------------------------
echo Usage: make.bat [target]
echo.
echo To override variables:
echo   set quality=80 ^&^& make.bat build
echo.
echo Targets:
echo   install   - Create venv and install dependencies
echo   build     - Run full build (Default)
echo   fast      - Run build without watermarking or git updates
echo   clean     - Remove build directory
echo   deepclean - Remove venv, logs, build dir, and cache
goto :eof