import os

import jd_analyzer
import resume_tailor
import cover_letter


def main():
    os.makedirs("outputs", exist_ok=True)

    jd_analyzer.main()
    resume_tailor.main()

    answer = input("\nGenerate cover letter? (y/n): ").strip().lower()
    cover_letter_generated = answer == "y"
    if cover_letter_generated:
        cover_letter.main()

    print("\nDone. Files saved to outputs/:")
    print("  - jd_analysis.json")
    print("  - tailored_resume.json")
    if cover_letter_generated:
        print("  - cover_letter.txt")
    else:
        print("  - cover_letter.txt (if generated)")


if __name__ == "__main__":
    main()
