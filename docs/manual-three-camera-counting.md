# Manual check of the screenshot counting lines

4 November 2026; serving counter `1.4.0-exp.9`. Geometry remains unchanged:
045 profile 39/v2, 049 profile 40/v3 and 052 profile 41/v2. Counts still require
confirmed bottom-centre crossings of the finite published line.

## Reviewed events

Thirty seconds of original, clock-qualified video per camera were reviewed in
chronological order using raw line-band sheets at 4 FPS. Whole frames and
neighbouring frames were examined for ambiguous occlusions, attached trailers,
line endpoints and cars travelling side by side. Initial visual notes were
adjudicated after inspecting differences with AI: several first-pass notes
followed the same departing 049 car twice, and its out-of-segment passes were
excluded. This is a manually reviewed sample, not a blind holdout or a general
accuracy certification.

| Camera | Manually reviewed vehicles | Previous AI events | Corrected AI events | Missed / extra events after correction |
| --- | ---: | ---: | ---: | --- |
| 045 · Ball Road | 59 | 63 | 59 | 0 / 0 |
| 049 · Jamboree | 68 | 68 | 68 | 0 / 0 |
| 052 · Imperial | 47 | 48 | 47 | 0 / 0 |

The 174 event labels, capture windows, exact definitions and source-segment
SHA-256 hashes are in `counter/dev/reviews/three-lines-20261104.json`. Visual
uncertainty is recorded as crossing-time brackets. Matching is one to one;
review also follows physical vehicles, so matching totals alone are insufficient.
No sampled vehicle is credited for entering an ROI or crossing a line extension.

## Fixes

On 045 the line crop spans two detector tiles. An incomplete body at an interior
tile boundary could survive NMS alongside the complete body from its neighbour.
The detector now prefers the complete measured body before NMS, even when the
fragment has the larger score. Removal requires a larger, non-clipped detection
covering at least 80% of the fragment. Lone crop-edge detections, weak unsupported
alternatives and distinct neighbouring vehicles remain. Outer video edges do
not constitute interior crop seams.

Fragments can also have differently timed crossing snapshots, whose boxes no
longer overlap after the vehicle moves. The counter now records the interpolated
point of the already observed line crossing. An additional duplicate check needs
nearby crossing points (within 35% of the smaller box's span along the line), the
existing 0.35-second time bound, compatible classes/direction, and at least two
simultaneous measured neural boxes overlapping by 30% or more. Strong evidence
of separate vehicles retains priority. No new crossing, class vote or trajectory
is inferred from this association. On 052 this removes the second ID over the
pickup with its attached trailer.

Neural fragment evidence is bounded to 32 observations per identity and stops
0.25 seconds after its crossing. Boxes above the existing minimum confidence can
support association, but do not become strong class votes. A weak crossing that
is demonstrably the fragment of an already confirmed vehicle no longer causes
a false refund. Unmatched weak crossings still fail verification; the new
negative regression explicitly checks that path. Public crossing fields and
the half-second green-fill lifetime remain unchanged.

## Verification and runtime

Actual CUDA inference was repeated from source footage with the final serving
image, at 15 FPS and 480/480 frames per camera. The retained detector modes are
YOLOX-S/line for 045 and YOLOX-M/full-frame for 049/052. Each corrected window has
zero unresolved weak crossings and passes the existing counting quality checks.
A separate replay of the final measurements checked live-progress metadata:
all 174 identities had highlights, no running count decreased, and the largest
highlight age was 0.4991 seconds. Changing 045 to full-frame inference alone was rejected: it introduced an
occlusion miss, so no model or coverage preset was changed.

The serving image passes 234 counter tests, with one optional test skipped.
New regressions include actual measured 045/052 observations, clipped versus
complete detector bodies, unsupported edge observations, adjacent overlapping
cars, known weak fragments versus a separate weak crossing, bounded association
history, and unchanged public crossing fields. Existing missed-car, glare,
reappearing-ID, finite-segment, clock and half-second-pulse regressions pass.

Separate differential replay of earlier 047/048 recordings preserves their
19/69 events. On the earlier night 051 recording it removes two extra body/light
IDs (66 to 64); those two passages were inspected on raw footage. These older
windows still fail their existing tracking checks and are not certified counts.
No additional vehicles were removed from those three controls, and their counts
did not decrease during progress replay.

Published snapshots and accepted prediction terms are preserved. API, frontend,
database and the CUDA counter are left running locally. Schedules remain enabled;
uncertain live windows continue through the existing refund path. Private source
video, first-pass notes, replay measurements and deployment receipts remain in
ignored `.tools/manual-three-lines-20261104/`.
