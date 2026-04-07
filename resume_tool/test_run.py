import json
import os
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def load_json(path):
    full = os.path.join(BASE_DIR, path)
    if not os.path.exists(full):
        print(f"FAIL: file not found: {path}")
        sys.exit(1)
    with open(full) as f:
        return json.load(f)

def check_tailored_resume():
    master = load_json("data/master_resume.json")
    tailored = load_json("outputs/tailored_resume.json")

    expected_keys = set(master.keys())
    actual_keys = set(tailored.keys())

    missing = expected_keys - actual_keys
    extra = actual_keys - expected_keys

    if missing:
        print(f"FAIL [tailored_resume]: missing keys: {missing}")
        sys.exit(1)
    if extra:
        print(f"FAIL [tailored_resume]: unexpected extra keys: {extra}")
        sys.exit(1)

def check_jd_analysis():
    required_fields = {"role", "company", "hard_skills", "keywords",
                       "key_responsibilities", "tone", "domain"}
    data = load_json("outputs/jd_analysis.json")

    missing = required_fields - set(data.keys())
    if missing:
        print(f"FAIL [jd_analysis]: missing required fields: {missing}")
        sys.exit(1)

def check_cover_letter():
    path = os.path.join(BASE_DIR, "outputs/cover_letter.txt")
    if not os.path.exists(path):
        print("FAIL [cover_letter]: file not found: outputs/cover_letter.txt")
        sys.exit(1)
    if os.path.getsize(path) == 0:
        print("FAIL [cover_letter]: file is empty")
        sys.exit(1)

if __name__ == "__main__":
    check_tailored_resume()
    check_jd_analysis()
    check_cover_letter()
    print("All checks passed")
