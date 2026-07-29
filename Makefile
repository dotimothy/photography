PYTHON      = python3
SCRIPT      = preparePortfolio.py
BUILD_DIR   = build
VENV        = .venv
# Point to the python executable inside the venv
VENV_PYTHON = $(VENV)/bin/python

# '?=' sets a default, but allows CLI overrides
quality ?= 80
jobs ?= 0

.PHONY: all build incremental clean install help fast exif deepclean icons

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

incremental: install
	$(VENV_PYTHON) $(SCRIPT) --watermark --quality $(quality) --jobs $(jobs)

fast: install
	$(VENV_PYTHON) $(SCRIPT) --html-only --quality $(quality) --jobs $(jobs)

web: install
	$(VENV_PYTHON) $(SCRIPT) --html-only

exif: install
	$(VENV_PYTHON) $(SCRIPT) --exif

# Regenerate PWA icons from a 1024x1024 source (assets/source-icon.png) if
# present, otherwise emit a stylized camera silhouette as a fallback.
icons: install
	$(VENV_PYTHON) modules/make_icons.py

clean:
	rm -rf $(BUILD_DIR)
	rm -rf __pycache__


deepclean: clean
	rm -rf $(VENV)
	rm -rf .cache 
	rm -rf tmp
	rm -rf logs

help:
	@echo "TheDoShoots Portfolio Makefile"
	@echo "------------------------------------------"
	@echo "Usage: make [target] quality=[value]"
	@echo ""
	@echo "make install   - Create venv and install dependencies"
	@echo "make build     - Run full build (auto-installs venv if missing)"
	@echo "make incremental - Reuse cached images and update changed content"
	@echo "make fast      - Run build skipping image processing and git updates"
	@echo "make web       - Just update HTML/JS/CSS assets (Fastest)"
	@echo "make clean     - Remove build directory"
	@echo "make deepclean - Remove venv, logs folder, build dir, and cache"
