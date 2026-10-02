# Desktop backgrounds

Open Settings > Appearance > Desktop background. Select Neon Glass, Classic grid, Dark graphite, or Choose image to upload a PNG, JPEG or WebP. Fill screen crops edges; Fit entire image preserves the entire image with graphite margins. Brightness ranges from25 to100 percent. A preview updates immediately.

Personal image preferences follow this browser/device's desktop layout, within your Linux account. They persist after reload/login. Uploads are limited to10MiB/40MP and decoded/re-encoded as JPEG (maximum edge2560px, maximum output5MiB); transparency is flattened onto graphite, animations become a still image, and source metadata is not copied. The original selected file remains unchanged. This is an optimized wallpaper copy, not a photo archive.

The copy is stored privately in `.config/neon-desktop/wallpaper-<device UUID>.jpg` through the normal HOME API. Presets do not erase it. Remove my image deletes that copy and returns to Neon Glass. The login screen remains minimal and never shows a user's wallpaper. Images are never fetched from third-party URLs. A missing/invalid personal file falls back to the bundled image and shows a notification.

## Bundled artwork

Project asset: `frontend/wallpapers/neon-glass.png`, copied to `dist/wallpapers/neon-glass.png` during build. Created with the built-in image_gen tool, inspected and selected for this project. No external stock assets. The source PNG is1672×941 pixels (approximately1.3MiB) and is preserved without resizing. This is raster wallpaper artwork, not a standalone vector logo master.

Generation prompt:

> Use case: stylized-concept. Asset type: default wallpaper for the real Linux web desktop Neon Desktop. Create a finished widescreen 16:9 desktop wallpaper, ideally 2560x1440 or larger. Premium minimalist modern developer workstation identity. Near-black graphite and very dark blue-green background, subtle luminous cyan and mint-green translucent glass ribbons forming a precise angular N monogram in the central area, occupying roughly 22% of the canvas width. Below the monogram small exquisitely typeset clean widely spaced sans-serif text exactly 'NEON DESKTOP'. Strong elegant geometric silhouette, refined glass material with restrained rim light, no excessive bloom. Very faint architectural/circuit-like lines fading into deep dark negative space toward the edges; mostly quiet dark background so windows and icons remain legible. Balanced center composition remains intact when cropped to narrower monitors. Contemporary polished product wallpaper, crisp edges, subtle depth, beautiful professional finish. No UI, no windows, no computer mockup, no extra words, no watermark, no busy Matrix rain, no bright full-screen green, no purple overload. Save the generated asset so it can be integrated into the project.
