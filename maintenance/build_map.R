# Build the small locator map (img/dry-valleys.png) from the USGS 1:250,000
# shaded-relief map of Ross Island & the Dry Valleys, and print each station's
# position on it (as % of the image width/height) for SITES in config.js.
#
#   Rscript maintenance/build_map.R
#
# Needs magick. Input: maintenance/RossIsland_DryValleys_250kDRG_HighRes.gif
# (3400 x 2199 px, not georeferenced).
#
# Georeferencing: the map is a conic projection, so meridians are straight lines
# through one centre point and parallels are circles around it. The graticule
# tick marks on the map frame (measured once from the GIF, below) pin that down:
# the fit reproduces the left/right latitude ticks to within 0.3 px.

suppressPackageStartupMessages(library(magick))

src    <- "maintenance/RossIsland_DryValleys_250kDRG_HighRes.gif"
out    <- "img/dry-valleys.png"
margin <- 280       # px of context (in the source, ~70 m/px, so ~20 km) around the outermost stations
aspect <- 1.7       # widen the crop to this width:height (about the map tile's shape on
                    # desktop); the page trims whatever doesn't fit, keeping stations centred
width  <- 680       # output width in px
colors <- 128       # PNG palette size

# Stations in the rotation (from the MCM LTER GPS list).
st <- data.frame(
  code = c("boym", "tarm", "ho2m", "caam", "frlm", "hodm", "cohm", "exem", "brhm", "vaam", "viam"),
  lat  = c(-77.71473, -77.74020, -77.62399, -77.61315, -77.61130, -77.67108, -77.56453, -77.58870, -77.43350, -77.52567, -77.37735),
  lon  = c(162.4647, 162.1284, 162.8995, 162.9647, 163.1701, 163.0784, 163.2826, 163.4175, 162.7036, 161.6913, 161.7991)
)

# --- Graticule ticks on the map frame (source pixels) ------------------------
frame <- c(top = 162, bottom = 2055.5, left = 114, right = 3265.5)
tick_lon    <- 161:169
tick_top    <- c(286.0, 644.0, 1001.0, 1358.5, 1715.0, 2072.0, 2429.5, 2787.0, 3145.5)
tick_bottom <- c(399.5, 724.5, 1049.5, 1374.5, 1699.0, 2023.5, 2348.5, 2674.0, 2999.5)
tick_lat    <- c(-77, -77.25, -77.5, -77.75, -78)
tick_left   <- c(354.0, 749.0, 1143.5, 1538.0, 1932.5)
tick_right  <- c(377.5, 773.0, 1168.0, 1562.5, 1957.5)

# Centre: least-squares meeting point of the meridians (top tick -> bottom tick).
d  <- cbind(tick_bottom - tick_top, frame[["bottom"]] - frame[["top"]])
n  <- cbind(d[, 2], -d[, 1]) / sqrt(rowSums(d^2))
cc <- qr.solve(n, rowSums(n * cbind(tick_top, frame[["top"]])))

# Meridian angle is linear in longitude; parallel radius is smooth in latitude.
ang  <- atan2(tick_top - cc[1], cc[2] - frame[["top"]])
fa   <- lm(ang ~ tick_lon)
rad  <- (sqrt((frame[["left"]] - cc[1])^2 + (tick_left - cc[2])^2) +
         sqrt((frame[["right"]] - cc[1])^2 + (tick_right - cc[2])^2)) / 2
fr   <- lm(rad ~ poly(tick_lat, 2, raw = TRUE))

a  <- predict(fa, data.frame(tick_lon = st$lon))
r  <- predict(fr, data.frame(tick_lat = st$lat))
sx <- cc[1] + r * sin(a)
sy <- cc[2] - r * cos(a)

# --- Crop, shrink, write ------------------------------------------------------
y0 <- floor(min(sy) - margin); y1 <- ceiling(max(sy) + margin)
w  <- max(max(sx) - min(sx) + 2 * margin, (y1 - y0) * aspect)
x0 <- floor((min(sx) + max(sx)) / 2 - w / 2)
x0 <- min(max(x0, frame[["left"]] + 1), frame[["right"]] - 1 - w)   # stay inside the map frame
x1 <- ceiling(x0 + w)
img <- image_read(src)
img <- image_crop(img, geometry_area(x1 - x0, y1 - y0, x0, y0))
img <- image_resize(img, geometry_size_pixels(width = width), filter = "Lanczos")
img <- image_quantize(img, max = colors, colorspace = "sRGB", dither = TRUE)   # default "rgb" darkens it
dir.create(dirname(out), showWarnings = FALSE)
image_write(img, out, format = "png", depth = 8)

info <- image_info(img)
cat(sprintf("%s  %d x %d px  (mapSize: [%d, %d] in config.js)\n", out, info$width, info$height, info$width, info$height))
px <- 100 * (sx - x0) / (x1 - x0)
py <- 100 * (sy - y0) / (y1 - y0)
for (i in seq_len(nrow(st))) cat(sprintf("  %s: map: [%.1f, %.1f]\n", st$code[i], px[i], py[i]))
