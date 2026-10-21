import json
from pathlib import Path
import subprocess
import sys
from PIL import Image
from test_regressions import ROOT, WorkspaceTest, module

imgdiff = module('imgdiff', 'skills/sim-verify-task/scripts/imgdiff.py')
builder = module('build_images', 'skills/sim-verify-task/scripts/build_report.py')


class ImageTests(WorkspaceTest):
    def images(self, first, second, size=(32, 32)):
        for folder, color in [('before', first), ('after', second)]:
            (self.root/folder).mkdir(exist_ok=True)
            Image.new('RGB', size, color).save(self.root/folder/'a.png')
        return self.root/'before/a.png', self.root/'after/a.png'

    def test_identical_images(self):
        before, after = self.images((80, 20, 40), (80, 20, 40))
        result = imgdiff.compare(before, after)
        self.assertTrue(result['same'])
        self.assertEqual(result['ssim'], 1)
        self.assertEqual(result['changed_frac'], 0)

    def test_equal_luminance_color_change_detected(self):
        before, after = self.images((255, 0, 0), (0, 130, 0))
        result = imgdiff.compare(before, after, self.root/'diff.png')
        self.assertFalse(result['same'])
        self.assertEqual(result['changed_frac'], 1)
        self.assertTrue(result['bboxes'])
        self.assertNotEqual(Image.open(self.root/'diff.png').getpixel((0, 0)), (0, 130, 0))

    def test_single_native_pixel_is_not_hidden_by_resize(self):
        before, after = self.images('white', 'white', (1200, 2400))
        with Image.open(after) as source:
            changed = source.copy()
        changed.putpixel((700, 1800), (0, 0, 0))
        changed.save(after)
        result = imgdiff.compare(before, after)
        self.assertFalse(result['same'])
        self.assertEqual(result['changed_pixels'], 1)
        self.assertEqual(result['bboxes'], [[700, 1800, 700, 1800]])

    def test_size_mismatch_is_error(self):
        before, after = self.images('black', 'black')
        Image.new('RGB', (40, 40), 'black').save(after)
        self.assertIn('error', imgdiff.compare(before, after))

    def test_batch_missing_and_empty_fail(self):
        before, after = self.images('black', 'white')
        after.unlink()
        result = subprocess.run([sys.executable, str(ROOT/'skills/sim-verify-task/scripts/imgdiff.py'), str(before.parent), str(after.parent), str(self.root/'diff')], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)['a']['error'], 'no after image')
        before.unlink()
        result = subprocess.run([sys.executable, str(ROOT/'skills/sim-verify-task/scripts/imgdiff.py'), str(before.parent), str(after.parent), str(self.root/'diff')], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('no screenshot pairs', result.stderr)

    def test_embedded_report_contains_png(self):
        self.write('tasks/T1/task.json', {'branch': 'feature'})
        self.write('tasks/T1/runs/1/report.json', {'criteria': [{'before': 'runs/1/before/a.png'}]})
        shot = self.root/'tasks/T1/runs/1/before/a.png'
        shot.parent.mkdir()
        Image.new('RGB', (20,20), 'red').save(shot)
        builder.build(self.root/'tasks', self.root/'report.html', embed=True)
        self.assertIn('data:image/png;base64,iVBOR', (self.root/'report.html').read_text())
