PYTHON      = python3
SCRIPT      = preparePortfolio.py
BUILD_DIR   = build
VENV        = .venv
# Point to the python executable inside the venv
VENV_PYTHON = $(VENV)/bin/python

# '?=' sets a default, but allows CLI overrides
quality ?= 60
jobs ?= 0

.PHONY: all build clean install help fast exif deepclean

default: build

all: deepclean build

# The 'install' target now acts as a prerequisite for build
install: $(VENV)/bin/activate

$(VENV)/bin/activate: requirements.txt
	@echo "Creating virtual environment..."
	test -d $(VENV) || $(PYTHON) -m venv $(VENV)
	$(VENV_PYTHON) -m pip install --upgrade pip
	$(VENV_PYTHON) -m pip install -r requirements.txt
	touch $(VENV)/bin/activate

build: install
	$(VENV_PYTHON) $(SCRIPT) --watermark --full-clean --quality $(quality) --jobs $(jobs)

fast: install
	$(VENV_PYTHON) $(SCRIPT) --skip-repo --quality $(quality) --jobs $(jobs)

exif: install
	$(VENV_PYTHON) $(SCRIPT) --exif

clean:
	rm -rf $(BUILD_DIR)

deepclean: clean
	rm -rf $(VENV)
	rm -rf .cache
	rm -rf tmp

help:
	@echo "TheDoShoots Portfolio Makefile"
	@echo "------------------------------------------"
	@echo "Usage: make [target] quality=[value]"
	@echo ""
	@echo "make install   - Create venv and install dependencies"
	@echo "make build     - Run full build (auto-installs venv if missing)"
	@echo "make fast      - Run build without watermarking or git updates"
	@echo "make clean     - Remove build directory"
	@echo "make deepclean - Remove venv, build dir, and cache"