// src/cli/app/pages/settings/settings-page.tsx

import { Box } from "ink";
import type { AppViewProps } from "@/cli/app/AppView";
import { PageFrame } from "@/cli/app/pages/page-frame";
import { useSettingsPage } from "@/cli/app/pages/settings/use-settings-page";
import { colors } from "@/cli/components/colors";
import { Text } from "@/cli/components/Text";
import {
  useInputScopeClaim,
  useKeyBindings,
} from "@/cli/hooks/use-input-router";
import { OverlayTextField } from "@/cli/overlay/text-view";

/**
 * Settings, as a page (P3).
 *
 * The frame is `PageFrame` — height, rail, panel, scrolling, `↑↓`/`PgUp`/`Esc`,
 * the mouse's row contract — and this file adds only what is the settings page's
 * own: the inline editor that replaces the header row while it is open, and the
 * error it reports in place (《38》§12.4 5: an invalid value stays on screen, it is
 * not silently clamped).
 *
 * The editor takes the `overlay` scope rather than sitting inside the page's, so
 * the frame's `↑↓`/`Esc` stand down while a value is being typed: one owner of the
 * keyboard, the same rule every face follows.
 */
export function SettingsPage(view: AppViewProps) {
  const page = useSettingsPage(view);
  const { editor } = page;

  return (
    <PageFrame
      view={view}
      body={page.body}
      actions={page.actions}
      headerSlot={
        editor ? (
          <SettingsEditor
            editor={editor}
            onChange={page.setDraft}
            onSubmit={page.submitEditor}
            onCancel={page.cancelEditor}
          />
        ) : page.note ? (
          // The feedback sits in the header rather than at the end of the body:
          // the body scrolls, and a note appended to it can land under a long
          // screen — a change that says nothing is worse than no feedback at all
          // (《38》§12.4 7).
          <SettingsHeader body={page.body} note={page.note} />
        ) : undefined
      }
    />
  );
}

function SettingsHeader({
  body,
  note,
}: {
  body: ReturnType<typeof useSettingsPage>["body"];
  note: string;
}) {
  const header =
    body.breadcrumb && body.breadcrumb.length > 0
      ? body.breadcrumb.join(" / ")
      : body.title;
  return (
    <Box flexDirection="row">
      <Text bold>{header}</Text>
      <Text dimColor>{`  ·  ${note}`}</Text>
    </Box>
  );
}

function SettingsEditor({
  editor,
  onChange,
  onSubmit,
  onCancel,
}: {
  editor: NonNullable<ReturnType<typeof useSettingsPage>["editor"]>;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  useInputScopeClaim("overlay", true);
  useKeyBindings("settings-editor", [
    {
      scope: "overlay",
      bindings: [
        {
          id: "settings.editor.submit",
          chords: [{ key: "return" }],
          label: "提交",
          run: () => {
            onSubmit();
            return "consumed";
          },
        },
        {
          id: "settings.editor.cancel",
          chords: [{ key: "escape" }],
          label: "取消",
          run: () => {
            onCancel();
            return "consumed";
          },
        },
      ],
    },
  ]);

  return (
    <Box flexDirection="row">
      <Text color={colors.selector.itemHighlighted}>{`${editor.label}: `}</Text>
      <OverlayTextField
        value={editor.draft}
        onChange={onChange}
        marker={null}
        focus
      />
      {editor.error !== null && (
        <Text color={colors.status.error}>{`  ${editor.error}`}</Text>
      )}
    </Box>
  );
}
