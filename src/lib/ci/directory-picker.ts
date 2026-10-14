/**
 * Switch for the Microsoft directory picker on User Management's Add User form.
 *
 *   false        Add User takes the name and email typed in the form. The server does not look
 *                the person up in the Microsoft directory. Corporate Marketing authorization of
 *                the person adding the user is unchanged.
 *   true         Add User picks the person from the Microsoft directory (needs the Graph
 *                Application permission User.Read.All with admin consent), and the server
 *                re-checks the email against the directory and saves the directory's own
 *                email and name.
 *
 * ON now (the owner asked for it). Set it to false to go back to typed names and emails: that is the
 * only change needed; everything the picker uses stays in place.
 */
export const MICROSOFT_DIRECTORY_PICKER_ENABLED = true;
