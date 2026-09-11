import MeetingBoard from "../../../../../../meeting-board";

export default async function GroupMeetingAdmin({
  params,
}: {
  params: Promise<{ group: string }>;
}) {
  const { group } = await params;
  return <MeetingBoard group={group} isAdmin />;
}
