// src/cli/app/pages/settings/settings-page.tsx

import { Box, type DOMElement } from "ink";
import { useRef } from "react";
import type { AppViewProps } from "@/cli/app/AppView";
import { PageFrame } from "@/cli/app/pages/page-frame";
import {
  type Crumb,
  crumbText,
  useCrumbClicks,
} from "@/cli/app/pages/settings/use-crumb-clicks";
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
 * own: the header (breadcrumb, the keys that work here, the transient note) and the
 * inline editor that replaces that header while a value is being typed.
 *
 * **The header carries the keys, not the rows.** They used to sit at each row's end
 * (`Space`, `←→`, `⏎`), where a narrow terminal cut them off first and, next to a
 * value, they read as part of it. One line that says what this screen accepts is
 * shorter, and it is the only place the note can live without scrolling away.
 *
 * **The breadcrumb is clickable.** A page owns the main area, so `Esc` is the
 * keyboard's way back — and the pointer had none inside the tree. Each segment that
 * names a screen (and the root's own `Settings`) is a target; the root's leaves for
 * the conversation, which is what `Esc` does there.
 *
 * The editor takes the `overlay` scope rather than sitting inside the page's, so the
 * frame's `↑↓`/`Esc` stand down while a value is being typed: one owner of the
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
        ) : (
          <SettingsHeader
            crumbs={page.crumbs}
            aside={page.note ?? page.hint}
            note={page.note !== null}
            onSelectCrumb={page.selectCrumb}
          />
        )
      }
    />
  );
}

function SettingsHeader({
  crumbs,
  aside,
  note,
  onSelectCrumb,
}: {
  crumbs: readonly Crumb[];
  aside: string;
  note: boolean;
  onSelectCrumb: (crumb: Crumb) => void;
}) {
  const headerRef = useRef<DOMElement | null>(null);
  useCrumbClicks({ ref: headerRef, crumbs, onSelect: onSelectCrumb });

  return (
    <Box ref={headerRef} flexDirection="row">
      <Text bold>{crumbText(crumbs)}</Text>
      <Text dimColor color={note ? colors.status.success : undefined}>
        {`   ${aside}`}
      </Text>
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
          label: "Save",
          run: () => {
            onSubmit();
            return "consumed";
          },
        },
        {
          id: "settings.editor.cancel",
          chords: [{ key: "escape" }],
          label: "Cancel",
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
