import tempfile
import unittest
from pathlib import Path
from modules import builder


class GalleryNavigationTests(unittest.TestCase):
    def test_generated_gallery_and_immersive_viewer_have_a_return_link(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            template = root / 'template'
            template.mkdir()
            for name in ['index.html', 'immersive.html']:
                (template / name).write_text('<html><head><title>Gallery</title></head><body><h1 id="title">Gallery</h1></body></html>')
            builder.generate_site(['astronomy'], {'astronomy': ['photo.jpg']},
                                  {'astronomy': {'photo': {}}}, str(root / 'portfolios'), {}, str(template))
            for name in ['index.html', 'immersive.html']:
                content = (root / 'portfolios/astronomy' / name).read_text(encoding='utf-8')
                self.assertIn('href="../../index.html?mode=3d" target="_top"', content)
                self.assertIn('Back to Camera', content)
                self.assertIn('../../assets/css/gallery-return.css', content)
                self.assertIn('../../assets/js/gallery-return.js', content)
                self.assertIn('../../assets/js/gallery-inspector.js', content)
                self.assertIn('id="portfolio-inspector"', content)
                self.assertEqual(builder.add_gallery_return_navigation(content), content)


if __name__ == '__main__':
    unittest.main()
