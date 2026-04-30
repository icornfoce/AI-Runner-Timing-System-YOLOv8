import os
import pandas as pd


def load_registry(filepath):
    """โหลด registry จากไฟล์ CSV คืนค่า dict {name: bib_number}"""
    if os.path.exists(filepath):
        df = pd.read_csv(filepath)
        return dict(zip(df['Name'], df['BibNumber'].astype(str)))
    return {}


def get_bib_to_owner(registry):
    """สร้าง reverse lookup dict {bib_number: name} จาก registry"""
    return {v: k for k, v in registry.items()}
