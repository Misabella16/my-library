import unittest
from html.parser import HTMLParser
from pathlib import Path

class Layout(HTMLParser):
    def __init__(self):
        super().__init__(); self.stack=[]; self.nodes={}; self.duplicates=[]
    def handle_starttag(self,tag,attrs):
        node={'tag':tag,'attrs':dict(attrs),'parents':list(self.stack)}
        id=node['attrs'].get('id')
        if id:
            if id in self.nodes:self.duplicates.append(id)
            self.nodes[id]=node
        if tag not in {'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'}:self.stack.append(node)
    def handle_endtag(self,tag):
        for index in range(len(self.stack)-1,-1,-1):
            if self.stack[index]['tag']==tag:
                self.stack=self.stack[:index];break

class ImportsLayoutTests(unittest.TestCase):
    def setUp(self):
        self.layout=Layout();self.layout.feed((Path(__file__).parents[1]/'index.html').read_text())
    def parents(self,id):return [n['attrs'].get('id') for n in self.layout.nodes[id]['parents']]
    def test_single_main_repair_and_unique_control_ids(self):
        self.assertEqual(self.layout.duplicates,[])
        self.assertIn('online-enrich',self.parents('online-apply'))
        self.assertNotIn('repair-advanced',self.parents('online-apply'))
        for id in ['collection-health-smart-repair','collection-health-repair','epub-backfill-bulk','upload-epubs']:
            self.assertIn('hidden',self.layout.nodes[id]['attrs'])
    def test_advanced_tools_are_collapsed_and_optional(self):
        for id in ['collection-health','epub-backfill','existing-cover-relink','offline-bulk']:
            self.assertIn('repair-advanced',self.parents(id))
        self.assertNotIn('open',self.layout.nodes['repair-advanced']['attrs'])
    def test_imports_and_history_have_clear_homes(self):
        for id in ['goodreads-file','epub-files','digital-files','calibre-file']:
            self.assertIn('add-library-books',self.parents(id))
        for id in ['online-results','online-history-btn','epub-backfill-history','epub-backfill-undo','relink-existing-history','goodreads-import-history','goodreads-sync-history']:
            self.assertIn('repair-review',self.parents(id))
