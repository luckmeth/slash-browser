package dev.slash.browser.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Matrix
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The Slash mark.
 *
 * A direct port of `src/renderer/components/BrandMark.tsx`, using that file's
 * own SVG path strings so the two hold the same geometry rather than two
 * descriptions of it. The first Android build drew a plain diagonal stroke,
 * which is not the logo — it is one third of it.
 *
 * The mark is an **S cut by a diagonal**: two arcs facing opposite ways, and a
 * slash that separates them and overshoots at both ends. The slash is drawn as
 * its own stroke *and* cleared out of the S at a wider width, so a hairline of
 * background runs either side of it. That keyline is what stops the two shapes
 * reading as one blob at small sizes, and it is a *cut* rather than a line drawn
 * on top so the mark works on any ground.
 *
 * Geometry is scaled by a matrix rather than by `scale { }` around the drawing.
 * `saveLayer` takes its bounds in the current coordinate space, so scaling the
 * canvas made the layer 64×64 *device* pixels and the mark came out visibly
 * ragged at every size. Transforming the path leaves the layer at full
 * resolution.
 */
@Composable
fun BrandMark(
    size: Dp = 50.dp,
    color: Color = Slash.TextPrimary,
    modifier: Modifier = Modifier
) {
    Canvas(modifier.size(size)) {
        val k = this.size.minDimension / 64f
        val scaleMatrix = Matrix().apply { scale(k, k) }

        fun path(d: String): Path =
            PathParser().parsePathString(d).toPath().apply { transform(scaleMatrix) }

        // The `d` strings from BrandMark.tsx, verbatim.
        val upperBowl = path("M 43.5 19.5 A 11.6 11.6 0 1 0 27.5 35.2")
        val lowerBowl = path("M 20.5 44.5 A 11.6 11.6 0 1 0 36.5 28.8")

        drawIntoCanvas { canvas ->
            canvas.saveLayer(Rect(Offset.Zero, this.size), Paint())

            drawPath(upperBowl, color, style = Stroke(width = 7.25f * k, cap = StrokeCap.Butt))
            drawPath(lowerBowl, color, style = Stroke(width = 7.25f * k, cap = StrokeCap.Butt))

            // The cut: wider than the slash, removing pixels rather than
            // painting over them, so the hairline shows the real background.
            drawLine(
                color = Color.Transparent,
                start = Offset(18.5f * k, 55f * k),
                end = Offset(45.5f * k, 9f * k),
                strokeWidth = 9.75f * k,
                cap = StrokeCap.Butt,
                blendMode = BlendMode.Clear
            )
            canvas.restore()
        }

        // The slash itself, narrower than the cut, overshooting both bowls.
        drawLine(
            color = color,
            start = Offset(20.5f * k, 55.5f * k),
            end = Offset(43.5f * k, 8.5f * k),
            strokeWidth = 5.75f * k,
            cap = StrokeCap.Butt
        )
    }
}
