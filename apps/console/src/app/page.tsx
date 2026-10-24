import { Frame } from "../components/frame.tsx";
import { HomeScreen } from "../features/home/home.tsx";

export default function HomePage() {
  return (
    <Frame section="home">
      <HomeScreen />
    </Frame>
  );
}
