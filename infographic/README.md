# TeamAI infographic (HTML)

An editable HTML rebuild of the TeamAI poster. Open `index.html` in a browser
(or serve the folder) and use the Zoom slider to work at a comfortable size.

## How it is put together

The canvas is 866 × 908 px — the size of the original artwork.

- `img/cNa.png` / `img/cNb.png` are the 16 illustration panels cropped from the
  original poster, plus `hand.png` (handwritten line) and `footer.png`.
- Every piece of copy is a `.t` element: an opaque white patch positioned over
  the baked-in text of the bitmap underneath. Edit the text in `index.html`.
- Bullets, icons, charts and agent logos are left in the bitmaps, so the white
  patches are deliberately narrow — widening one can cover a character or an
  illustration that sits on top of the white card.

Colours, font sizes and the zoom default live in the `:root` block of
`styles.css`.
