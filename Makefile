PYTHON = python
SCRIPT = preparePortfolio.py
BUILD_DIR = build

# '?=' sets a default, but allows CLI overrides (e.g., make build quality=90)
quality ?= 60
jobs ?= 0

.PHONY: all build clean install help fast exif

all: install build

help:
	@echo "TheDoShoots Portfolio Build System (Linux)"
	@echo "------------------------------------------"
	@echo "Usage: make [target] quality=[value]"
	@echo ""
	@echo "make install  - Install Python dependencies"
	@echo "make build    - Run full build (clean, watermark, quality $(quality))"
	@echo "make fast     - Run build without watermarking or git updates"
	@echo "make clean    - Remove build directory"
	@echo "make exif     - Launch EXIF Editor"

install:
	$(PYTHON) -m pip install --upgrade pip
	$(PYTHON) -m pip install -r requirements.txt

build:
	$(PYTHON) $(SCRIPT) --watermark --full-clean --quality $(quality) --jobs $(jobs)

fast:
	$(PYTHON) $(SCRIPT) --skip-repo --quality $(quality) --jobs $(jobs)

clean:
	rm -rf $(BUILD_DIR)

exif:
	$(PYTHON) $(SCRIPT) --exif