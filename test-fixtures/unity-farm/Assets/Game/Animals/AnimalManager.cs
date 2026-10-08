namespace Game.Animals
{
    public class AnimalManager
    {
        public float CalculateGrowth(float bornAt, float now, float growTime)
        {
            float elapsed = now - bornAt;
            if (elapsed < 0) elapsed = 0;
            float ratio = elapsed / growTime;
            if (ratio > 1f) ratio = 1f;
            float eased = ratio * ratio * (3f - 2f * ratio);
            float result = eased * 100f;
            if (result < 0.01f) result = 0f;
            return result;
        }
    }
}
