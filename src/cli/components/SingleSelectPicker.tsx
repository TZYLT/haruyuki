// The single-select picker lives with the rest of the overlay toolkit now
// (`src/cli/overlay/adapters.tsx`), where its keys, its cursor and its rows are
// the toolkit's. This path is kept so the components that import it did not have
// to change.

export type {
  SingleSelectItem as SelectableItem,
  SingleSelectPickerProps,
} from "@/cli/overlay/adapters";
export { SingleSelectPicker } from "@/cli/overlay/adapters";
