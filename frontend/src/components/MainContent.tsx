import MusicSection from './MusicSection';
import { useAuth } from '../contexts/AuthContext';

const MainContent: React.FC = () => {
  const { user } = useAuth();

  return (
    <div className="space-y-8"> {/* Increased space between sections for better visuals */}
      {user && (
        <MusicSection 
          title="Recently Played" 
          fetchUrl="/api/me/history" 
        />
      )}
      <MusicSection 
        title="Featured" 
        fetchUrl="/api/songs/featured" 
      />
      <MusicSection
        title="Latest Punjabi"
        fetchUrl="/api/songs?language=punjabi"
      />
      <MusicSection
        title="Top English"
        fetchUrl="/api/songs?language=english"
      />
      <MusicSection
        title="Bollywood Hits"
        fetchUrl="/api/songs?language=hindi"
      />
      <MusicSection
        title="Latin Vibes"
        fetchUrl="/api/songs?language=spanish"
      />
      <MusicSection
        title="K-Pop"
        fetchUrl="/api/songs?language=korean"
      />
      <MusicSection
        title="Hip Hop"
        fetchUrl="/api/songs?genre=Hip Hop"
      />
      <MusicSection
        title="R&B"
        fetchUrl="/api/songs?genre=R%26B"
      />
      <MusicSection
        title="Indie"
        fetchUrl="/api/songs?genre=Indie"
      />
      <MusicSection
        title="Classical"
        fetchUrl="/api/songs?genre=Classical"
      />
    </div>
  );
};

export default MainContent;