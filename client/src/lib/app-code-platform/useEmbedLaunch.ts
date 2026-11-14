/**
 * Platform hook: useEmbedLaunch
 *
 * Tells app code whether this page was opened as a signed app embed, and
 * passes on the unsigned launch hints from the embed link.
 */

import { useState } from "react";
import { getEmbedLaunch, type EmbedLaunch } from "@/lib/auth-token";

function readEmbedLaunch(): EmbedLaunch {
	const launch = getEmbedLaunch();
	return Object.freeze({
		isEmbed: launch.isEmbed,
		unsigned: Object.freeze({ ...launch.unsigned }),
	});
}

/**
 * Describe how this page was launched.
 *
 * `isEmbed` is true only when this tab holds a valid app embed session.
 * `unsigned` carries the `ticket_id` / `client_id` hints from the embed link
 * (empty unless `isEmbed`). They are UNSIGNED: the person in the frame can
 * change them, so never use them for authorisation. The values do not change
 * during a page's life, and the returned object is stable across renders.
 */
export function useEmbedLaunch(): EmbedLaunch {
	const [launch] = useState(readEmbedLaunch);
	return launch;
}
