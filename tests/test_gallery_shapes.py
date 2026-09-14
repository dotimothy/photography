import tempfile
import unittest
from pathlib import Path
from modules import builder


class GalleryShapeTests(unittest.TestCase):
    def test_shape_configuration_is_separate_optional_and_escaped(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            template = root / 'template'
            template.mkdir()
            (template / 'index.html').write_text('<html><head><meta name="gallery-shape-emoji" content="old"></head><body></body></html>')
            for value in [None, '⭐', '\"<test>']:
                builder.generate_site(['test'], {'test': ['one.jpg']}, {'test': {'one': {}}},
                                      str(root / 'output'), {'test': 'DISPLAY'}, str(template),
                                      {'test': value} if value else None)
                page = (root / 'output/test/index.html').read_text(encoding='utf-8')
                self.assertNotIn('content="old"', page)
                if value:
                    self.assertEqual(page.count('name="gallery-shape-emoji"'), 1)
                    self.assertIn(builder.html.escape(value, quote=True), page)
                else:
                    self.assertNotIn('gallery-shape-emoji', page)
