import json
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
                                  {'astronomy': {'photo': {}}}, str(root / 'portfolios'), str(template))
            for name in ['index.html', 'immersive.html']:
                content = (root / 'portfolios/astronomy' / name).read_text(encoding='utf-8')
                self.assertIn('href="../../index.html?mode=3d" target="_top"', content)
                self.assertIn('<span class="portfolio-return-label">Back To Camera</span>', content)
                self.assertNotIn('Back to Camera', content)
                for asset in ['css/portfolio-controls.css', 'css/gallery-return.css', 'js/gallery-return.js',
                              'js/gallery-layout.js', 'js/gallery-inspector.js']:
                    self.assertEqual(content.count('../../assets/' + asset), 1, asset)
                # The shared control styles load first; the gallery layout builds on their tokens.
                self.assertLess(content.index('css/portfolio-controls.css'), content.index('css/gallery-return.css'))
                self.assertEqual(content.count('id="portfolio-return"'), 1)
                self.assertEqual(content.count('id="portfolio-inspector"'), 1)
                self.assertIn('>AI Inspector</button>', content)
                self.assertEqual(builder.add_gallery_return_navigation(content), content)

    def test_selects_keep_the_configured_order_and_the_full_archive(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            template = root / 'template'
            (template / 'js').mkdir(parents=True)
            (template / 'js/app.js').write_text(
                "this.images = data.image_order || Object.keys(data).filter(k => k !== 'image_order');",
                encoding='utf-8',
            )
            builder.generate_site(
                ['astronomy'], {'astronomy': ['first.jpg', 'second.jpg', 'third.jpg']},
                {'astronomy': {}}, str(root / 'portfolios'), str(template),
                selects={'astronomy': ['third', 'missing', 'first', 'third']},
            )
            gallery = root / 'portfolios/astronomy'
            metadata = json.loads((gallery / 'metadata/metadata.json').read_text(encoding='utf-8'))
            self.assertEqual(metadata['image_order'], ['first', 'second', 'third'])
            self.assertEqual(metadata['selects_order'], ['third', 'first'])
            app = (gallery / 'js/app.js').read_text(encoding='utf-8')
            self.assertIn("get('view') === 'selects'", app)
            self.assertIn('this.images = data.selects_order', app)


if __name__ == '__main__':
    unittest.main()
