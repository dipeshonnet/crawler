# PDF fonts

The crawler embeds these fonts in its PDFs; no system font installation is needed.

- Noto Sans: Latin, Greek, and Cyrillic.
- Noto Sans Arabic: Arabic.
- Noto Sans Devanagari: Hindi and other Devanagari text.
- Noto Sans CJK SC: Chinese, Japanese, and Korean, using Simplified Chinese glyph forms.

Fonts come from the [Noto fonts repository](https://github.com/notofonts/noto-fonts)
and the [Noto CJK repository](https://github.com/notofonts/noto-cjk).
The accompanying license files contain their SIL Open Font License terms.

PDF generation uses Playwright's Chromium renderer for font fallback, text
shaping, and bidirectional layout. The fonts are embedded in the HTML sent to
Chromium, so PDF export does not download fonts or depend on system fonts.
Install the packages from `requirements.txt` and run `python -m playwright
install chromium` when setting up a new environment. The project launcher
uses the Chromium installation in `.browsers`.
